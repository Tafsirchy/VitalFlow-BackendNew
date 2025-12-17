const { MongoClient, ServerApiVersion } = require("mongodb");
const express = require("express");
const cors = require("cors");

require("dotenv").config();
const port = process.env.PORT || 3000;

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

// const verifyFbToken = async (req, res, next) => {
//   const token = req.headers.authorization;

//   if (!token) {
//     return res.status(401).send({ message: "Unauthorize Access" });
//   }

//   try {
//     const idToken = token.split(" ")[1];
//     const decoded = await admin.auth().verifyIdToken(idToken);
//     console.log("Decoded info", decoded);
//     req.decoded_email = decoded.email;
//     next();
//   } catch (error) {
//     return res.status(401).send({ message: "Unauthorize Access" });
//   }
// };

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
