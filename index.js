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
    // console.log("Decoded info", decoded);
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
    // await client.connect();
    // Send a ping to confirm a successful connection

    const database = client.db("VitalFlow");
    const donorCollection = database.collection("Donors");
    const requestCollection = database.collection("Requests");
    const paymentCollection = database.collection("Payments");

    // insert donor data to database
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

      // validate role values
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
      // console.log(result);

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
          .sort({ createdAt: -1 })
          .limit(3)
          .toArray();

        res.send(result);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to fetch recent requests", error });
      }
    });

    // Update donation status done or cancel
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
          requester_email: email,
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

    // admin delete any request (admin only)
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
          donation_status: "pending",
        };

        if (bloodGroup !== "all") {
          query.bloodGroup = bloodGroup;
        }

        const result = await requestCollection
          .find(query)
          .sort({ createdAt: -1 })
          .limit(4)
          .toArray();

        res.send(result);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed to fetch urgent requests", error });
      }
    });

    // payment
    app.post("/create-payment-checkout", async (req, res) => {
      const information = req.body;
      const amount = parseInt(information.donateAmount) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: "Organization Fund Donation" },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        metadata: {
          donorName: information?.donorName || "Anonymous",
          donorEmail: information?.donorEmail || "",
        },
        customer_email: information.donorEmail,
        success_url: `${process.env.SITE_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/payment-cancelled`,
      });

      res.send({ url: session.url });
    });

    // success payment
    app.post("/success-payment", async (req, res) => {
      const { session_id } = req.query;
      const session = await stripe.checkout.sessions.retrieve(session_id);
      const transactionId = session.payment_intent;
      const isPaymentExist = await paymentCollection.findOne({ transactionId });
      if (isPaymentExist) {
        return res.status(400).send({ message: "Payment already exist" });
      }
      if (session.payment_status === "paid") {
        const donorEmail = session.customer_email;
        const donor = await donorCollection.findOne({ email: donorEmail });
        const paymentInfo = {
          amount: session.amount_total / 100,
          currency: session.currency,
          donorEmail,
          donorName: donor?.name || "Anonymous",
          transactionId,
          payment_status: "paid",
          paidAt: new Date(),
        };
        const result = await paymentCollection.insertOne(paymentInfo);
        return res.send(result);
      }
    });

    // all fundings
    app.get("/all-funding", async (req, res) => {
      try {
        const result = await paymentCollection
          .find()
          .sort({ paidAt: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        console.error("Failed to fetch funding:", error);
        res.status(500).send({
          message: "Failed to fetch funding data",
          error,
        });
      }
    });

    // Get total funding amount (for dashboard stats)
    app.get("/total-funding", async (req, res) => {
      const result = await paymentCollection
        .aggregate([
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$amount" },
              totalDonations: { $sum: 1 },
            },
          },
        ])
        .toArray();

      res.send({
        totalAmount: result[0]?.totalAmount || 0,
        totalDonations: result[0]?.totalDonations || 0,
      });
    });

    // search by filter
    app.get("/search-requests", async (req, res) => {
      let { bloodGroup, district, upazila } = req.query;

      const query = {};

      if (bloodGroup) {
        // FIX: convert space back to +
        bloodGroup = bloodGroup.replace(" ", "+");
        query.bloodGroup = bloodGroup;
      }

      if (district) {
        query.recipient_district = district;
      }

      if (upazila) {
        query.recipient_upazila = upazila;
      }

      // console.log(query);

      const result = await requestCollection.find(query).toArray();
      res.send(result);
    });

    // Get all pending donation requests
    app.get("/pending-donation-requests", async (req, res) => {
      try {
        const query = {
          donation_status: "pending",
        };

        const result = await requestCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        res.send(result);
      } catch (error) {
        console.error("Failed to fetch pending requests:", error);
        res.status(500).send({
          message: "Failed to fetch pending donation requests",
          error,
        });
      }
    });

    // details
    app.get("/requests/:id", async (req, res) => {
      const { ObjectId } = require("mongodb");
      const query = { _id: new ObjectId(req.params.id) };
      const result = await requestCollection.findOne(query);
      res.send(result);
    });

    app.patch(
      "/update-donation-status/:id",
      verifyFbToken,
      async (req, res) => {
        try {
          const { ObjectId } = require("mongodb");
          const { status } = req.body;
          const email = req.decoded_email;

          if (!["pending", "inprogress", "done", "canceled"].includes(status)) {
            return res.status(400).send({ message: "Invalid status" });
          }

          const request = await requestCollection.findOne({
            _id: new ObjectId(req.params.id),
          });

          if (!request) {
            return res.status(404).send({ message: "Request not found" });
          }

          if (request.requester_email === email) {
            return res
              .status(403)
              .send({ message: "You cannot donate to your own request" });
          }

          if (request.donation_status !== "pending") {
            return res
              .status(400)
              .send({ message: "Donation already accepted" });
          }

          const result = await requestCollection.updateOne(
            { _id: new ObjectId(req.params.id) },
            {
              $set: {
                donation_status: status,
                donor_email: email,
                donor_name: req.decoded_name || "Anonymous",
              },
            }
          );

          res.send(result);
        } catch (error) {
          res.status(500).send({
            message: "Failed to update donation status",
            error,
          });
        }
      }
    );

    app.patch("/donor/update/:email", verifyFbToken, async (req, res) => {
      try {
        const { email } = req.params;
        const { name, mainPhotoUrl, blood, district, upazila } = req.body;

        if (req.decoded_email !== email) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        if (!name || !blood || !district || !upazila) {
          return res.status(400).send({ message: "Missing required fields" });
        }

        const updateDoc = {
          $set: {
            name,
            blood,
            district,
            upazila,
            ...(mainPhotoUrl && { mainPhotoUrl }),
            updatedAt: new Date(),
          },
        };

        const result = await donorCollection.updateOne({ email }, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "User not found" });
        }

        res.send({ success: true });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Update failed" });
      }
    });

    // await client.db("admin").command({ ping: 1 });
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
