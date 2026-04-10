import express from "express";
import { createServer as createViteServer } from "vite";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import cors from "cors";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const DATA_FILE = path.join(process.cwd(), "data.json");

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  }
  return {};
}

function saveData(data: any) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getOAuth2Client(req: express.Request) {
  const redirectUri = `${req.protocol}://${req.get("host")}/auth/callback`;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );
}

app.get("/api/auth/url", (req, res) => {
  const oauth2Client = getOAuth2Client(req);
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
    prompt: "consent",
  });
  res.json({ url });
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const oauth2Client = getOAuth2Client(req);
    const { tokens } = await oauth2Client.getToken(code as string);
    
    const data = loadData();
    data.tokens = tokens;
    saveData(data);

    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Error exchanging code for tokens:", error);
    res.status(500).send("Authentication failed.");
  }
});

app.get("/api/auth/status", (req, res) => {
  const data = loadData();
  res.json({ authenticated: !!data.tokens });
});

app.post("/api/auth/logout", (req, res) => {
  const data = loadData();
  delete data.tokens;
  saveData(data);
  res.json({ success: true });
});

async function getAuthenticatedClient(req: express.Request) {
  const data = loadData();
  if (!data.tokens) {
    throw new Error("Not authenticated");
  }
  const oauth2Client = getOAuth2Client(req);
  oauth2Client.setCredentials(data.tokens);
  
  // Refresh token if needed
  oauth2Client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      data.tokens.refresh_token = tokens.refresh_token;
    }
    data.tokens.access_token = tokens.access_token;
    data.tokens.expiry_date = tokens.expiry_date;
    saveData(data);
  });

  return oauth2Client;
}

async function getOrCreateSheet(auth: any) {
  const data = loadData();
  const sheets = google.sheets({ version: "v4", auth });

  if (data.spreadsheetId) {
    try {
      // Verify sheet still exists
      await sheets.spreadsheets.get({ spreadsheetId: data.spreadsheetId });
      return data.spreadsheetId;
    } catch (e) {
      console.log("Sheet not found, creating a new one.");
    }
  }

  const resource = {
    properties: {
      title: "Fraser Suites Doha - In-room Dining Orders",
    },
    sheets: [
      {
        properties: {
          title: "Orders",
          gridProperties: {
            frozenRowCount: 1,
          },
        },
      },
    ],
  };

  const response = await sheets.spreadsheets.create({
    requestBody: resource,
    fields: "spreadsheetId",
  });

  const spreadsheetId = response.data.spreadsheetId;

  // Add headers
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Orders!A1:D1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [["Order ID", "Room Number", "Order Details", "Status"]],
    },
  });

  // Format headers
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: 0,
              startRowIndex: 0,
              endRowIndex: 1,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                textFormat: { bold: true },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
      ],
    },
  });

  data.spreadsheetId = spreadsheetId;
  saveData(data);

  return spreadsheetId;
}

app.post("/api/orders", async (req, res) => {
  try {
    const auth = await getAuthenticatedClient(req);
    const spreadsheetId = await getOrCreateSheet(auth);
    const sheets = google.sheets({ version: "v4", auth });

    const { roomNumber, items, totalPrice } = req.body;
    const orderId = Date.now().toString();
    const orderDetails = `Items: ${items.join(", ")} | Total: QAR ${totalPrice}`;
    const status = "Pending";

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Orders!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[orderId, roomNumber, orderDetails, status]],
      },
    });

    res.json({ success: true, orderId });
  } catch (error: any) {
    console.error("Error logging order:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/orders", async (req, res) => {
  try {
    const auth = await getAuthenticatedClient(req);
    const spreadsheetId = await getOrCreateSheet(auth);
    const sheets = google.sheets({ version: "v4", auth });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Orders!A2:D",
    });

    const rows = response.data.values || [];
    const orders = rows.map((row) => ({
      orderId: row[0],
      roomNumber: row[1],
      orderDetails: row[2],
      status: row[3],
    }));

    res.json({ success: true, orders });
  } catch (error: any) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/orders/:orderId/status", async (req, res) => {
  try {
    const auth = await getAuthenticatedClient(req);
    const spreadsheetId = await getOrCreateSheet(auth);
    const sheets = google.sheets({ version: "v4", auth });

    const { orderId } = req.params;
    const { status } = req.body;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: "Orders!A:D",
    });

    const rows = response.data.values || [];
    const rowIndex = rows.findIndex((row) => row[0] === orderId);

    if (rowIndex === -1) {
      return res.status(404).json({ error: "Order not found" });
    }

    // rowIndex is 0-based, but sheets are 1-based.
    // So if it's the 2nd row (index 1), we update D2.
    const rowNumber = rowIndex + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Orders!D${rowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[status]],
      },
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error("Error updating order status:", error);
    res.status(500).json({ error: error.message });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
