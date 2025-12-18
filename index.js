const { MongoClient, ServerApiVersion } = require("mongodb");
const express = require("express");
const cors = require("cors");
require("dotenv").config();
const port = process.env.PORT || 3000;
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const verifyFbToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "Unauthorize Access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("Decoded info", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "Unauthorize Access" });
  }
};

const uri = process.env.MONGODB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection

    const database = client.db("VitalFlow");
    const donorCollection = database.collection("Donors");
    const requestCollection = database.collection("Requests");

    // // insert donor data to database
    app.post("/donor", async (req, res) => {
      const donorInfo = req.body;
      donorInfo.createdAt = new Date();
      donorInfo.role = "Donor";
      donorInfo.status = "Active";
      const result = await donorCollection.insertOne(donorInfo);

      res.send(result);
    });

    // get all donor data from database
    app.get("/donor", verifyFbToken, async (req, res) => {
      const result = await donorCollection.find().toArray();
      res.status(200).send(result);
    });

    // check & set donor status from database
    app.patch("/update/donor/status", verifyFbToken, async (req, res) => {
      const { email, status } = req.body;

      if (!email || !status) {
        return res.status(400).send({ message: "Missing email or status" });
      }

      const query = { email };
      const updateStatus = {
        $set: { status },
      };

      const result = await donorCollection.updateOne(query, updateStatus);

      res.send(result);
    });

    // verify admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;

      const user = await donorCollection.findOne({ email });

      if (!user || user.role !== "Admin") {
        return res.status(403).send({ message: "Forbidden: Admin only" });
      }

      next();
    };

    //check and set role by admin
    app.patch("/update/donor/role", verifyFbToken, async (req, res) => {
      const { email, role } = req.body;

      if (!email || !role) {
        return res.status(400).send({ message: "Missing email or role" });
      }

      // Optional: Validate role values
      const validRoles = ["Donor", "Volunteer", "Admin"];
      if (!validRoles.includes(role)) {
        return res.status(400).send({ message: "Invalid role" });
      }

      const query = { email };
      const updateRole = {
        $set: { role },
      };

      const result = await donorCollection.updateOne(query, updateRole);

      res.send(result);
    });

    // get donor data from database by email
    app.get("/donor/role/:email", async (req, res) => {
      const email = req.params.email;

      const query = { email: email };
      const result = await donorCollection.findOne(query);
      console.log(result);

      res.send(result);
    });

    // add request data to database
    app.post("/requests", verifyFbToken, async (req, res) => {
      const requestInfo = req.body;
      requestInfo.createdAt = new Date();
      const result = await requestCollection.insertOne(requestInfo);
      res.send(result);
    });

    // my requests data from database and pagination functions
    app.get("/my-request", verifyFbToken, async (req, res) => {
      const email = req.decoded_email;
      const size = Number(req.query.size);
      const page = Number(req.query.page);
      const query = {
        requester_email: email,
      };

      const result = await requestCollection
        .find(query)
        .limit(size)
        .skip(size * page)
        .toArray();

      const totalRequest = await requestCollection.countDocuments(query);

      // size = 10; second page er jnno = 1*10; third page er jnno = 2*10 =20

      res.send({ request: result, totalRequest });
    });

    // Get recent 3 donation requests for dashboard
    app.get("/my-recent-requests", verifyFbToken, async (req, res) => {
      try {
        const email = req.decoded_email;
        const query = {
          requester_email: email,
        };

        const result = await requestCollection
          .find(query)
          .sort({ createdAt: -1 }) // Sort by newest first
          .limit(3) // Limit to 3 most recent
          .toArray();

        res.send(result);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to fetch recent requests", error });
      }
    });

    // Update donation status (Done/Cancel)
    app.patch(
      "/update-donation-status/:id",
      verifyFbToken,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body;

          if (
            !status ||
            !["done", "canceled", "pending", "inprogress"].includes(status)
          ) {
            return res.status(400).send({ message: "Invalid status" });
          }

          const { ObjectId } = require("mongodb");
          const query = { _id: new ObjectId(id) };
          const updateStatus = {
            $set: { donation_status: status },
          };

          const result = await requestCollection.updateOne(query, updateStatus);

          if (result.matchedCount === 0) {
            return res.status(404).send({ message: "Request not found" });
          }

          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to update status", error });
        }
      }
    );

    // Delete donation request
    app.delete("/delete-request/:id", verifyFbToken, async (req, res) => {
      try {
        const { id } = req.params;
        const email = req.decoded_email;

        const { ObjectId } = require("mongodb");
        const query = {
          _id: new ObjectId(id),
          requester_email: email, // Ensure user can only delete their own requests
        };

        const result = await requestCollection.deleteOne(query);

        if (result.deletedCount === 0) {
          return res
            .status(404)
            .send({ message: "Request not found or unauthorized" });
        }

        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to delete request", error });
      }
    });

    // Verify Admin or Volunteer middleware
    const verifyAdminOrVolunteer = async (req, res, next) => {
      const email = req.decoded_email;

      const user = await donorCollection.findOne({ email });

      if (!user || (user.role !== "Admin" && user.role !== "Volunteer")) {
        return res
          .status(403)
          .send({ message: "Forbidden: Admin or Volunteer only" });
      }

      next();
    };

    // Get all donation requests (accessible by Admin and Volunteer)
    app.get(
      "/all-requests",
      verifyFbToken,
      verifyAdminOrVolunteer,
      async (req, res) => {
        try {
          const size = Number(req.query.size);
          const page = Number(req.query.page);
          const filter = req.query.filter || "all";

          let query = {};
          if (filter !== "all") {
            query.donation_status = filter;
          }

          const result = await requestCollection
            .find(query)
            .sort({ createdAt: -1 })
            .limit(size)
            .skip(size * page)
            .toArray();

          const totalRequest = await requestCollection.countDocuments(query);

          res.send({ request: result, totalRequest });
        } catch (error) {
          res.status(500).send({ message: "Failed to fetch requests", error });
        }
      }
    );

    // Admin delete any request (Admin only)
    app.delete(
      "/admin/delete-request/:id",
      verifyFbToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { ObjectId } = require("mongodb");
          const query = { _id: new ObjectId(id) };

          const result = await requestCollection.deleteOne(query);

          if (result.deletedCount === 0) {
            return res.status(404).send({ message: "Request not found" });
          }

          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to delete request", error });
        }
      }
    );

    // Get urgent/recent blood donation requests
    app.get("/urgent-requests", async (req, res) => {
      try {
        const bloodGroup = req.query.bloodGroup || "all";

        let query = {
          donation_status: "pending", // Only show pending requests
        };

        if (bloodGroup !== "all") {
          query.bloodGroup = bloodGroup;
        }

        const result = await requestCollection
          .find(query)
          .sort({ createdAt: -1 }) // Most recent first
          .limit(4) // Only 4 requests
          .toArray();

        res.send(result);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to fetch urgent requests", error });
      }
    });

    // Update password in database (called after Firebase password reset)
    app.patch("/update-password", verifyFbToken, async (req, res) => {
      try {
        const email = req.decoded_email;
        const { newPassword } = req.body;

        if (!newPassword) {
          return res.status(400).send({ message: "New password is required" });
        }

        // Validate password strength (optional but recommended)
        if (newPassword.length < 8) {
          return res.status(400).send({
            message: "Password must be at least 8 characters long",
          });
        }

        const query = { email };
        const updatePassword = {
          $set: {
            password: newPassword,
            passwordUpdatedAt: new Date(),
          },
        };

        const result = await donorCollection.updateOne(query, updatePassword);

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({
          message: "Password updated successfully in database",
          result,
        });
      } catch (error) {
        console.error("Password update error:", error);
        res.status(500).send({ message: "Failed to update password", error });
      }
    });

    // Check if user exists before sending reset email
   app.post("/check-user-exists", async (req, res) => {
     try {
       const { email } = req.body;

       if (!email) {
         return res.status(400).send({ message: "Email is required" });
       }

       const user = await donorCollection.findOne({ email });

       // ✅ ALWAYS 200
       if (!user) {
         return res.send({
           exists: false,
           message: "No account found with this email",
         });
       }

       res.send({
         exists: true,
         message: "User found",
         name: user.name,
       });
     } catch (error) {
       res.status(500).send({ message: "Failed to check user", error });
     }
   });

   // payment
   app.post("/create-payment-checkout", async (req, res) => {
     const information = req.body;
     const amount = parseInt(information.amount) * 100;




   })

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Greetings from VitalFlow Server");
});

app.listen(port, () => {
  console.log(`Server is running on ${port}`);
});
