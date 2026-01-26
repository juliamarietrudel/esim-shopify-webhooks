import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("Webhook server running :)"));

app.post("/webhooks/order-paid", (req, res) => {
  console.log("🔥 Shopify webhook received");
  console.log(JSON.stringify(req.body, null, 2));
  res.status(200).send("OK");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));