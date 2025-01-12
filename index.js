require("dotenv").config();
const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");
const axios = require("axios");

const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON
app.use(express.json());

// Discord Bot Client Initialization
const discordBotToken = process.env.DISCORD_BOT_CLIENT_TOKEN;
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const redirectUri = "http://localhost:3000/auth/discord/redirect";

const botClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// In-memory storage for user tokens (Use a database in production)
const userTokens = {};

// Discord OAuth2 Authorization URL
const authUrl = `https://discord.com/oauth2/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(
  redirectUri
)}&response_type=code&scope=identify+bot&permissions=8`;

// API to get the OAuth2 URL
app.get("/api/discord/oauth-url", (req, res) => {
  res.json({ authUrl });
});

// OAuth2 Redirect Endpoint
app.get("/auth/discord/redirect", async (req, res) => {
  console.log("OAuth2 Redirect Hit");

  const { code } = req.query;
  if (code) {
    try {
      // Exchange authorization code for tokens
      const formData = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
      });

      const tokenResponse = await axios.post(
        "https://discord.com/api/v10/oauth2/token",
        formData.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      const { access_token, refresh_token } = tokenResponse.data;

      // Fetch user info
      const userResponse = await axios.get(
        "https://discord.com/api/v10/users/@me",
        {
          headers: {
            Authorization: `Bearer ${access_token}`,
          },
        }
      );

      const userId = userResponse.data.id;
      userTokens[userId] = {
        accessToken: access_token,
        refreshToken: refresh_token,
      };

      console.log(`User ${userId} authenticated:`, userResponse.data);

      return res.json({
        message: "Authorization successful",
        user: userResponse.data,
        tokens: tokenResponse.data,
      });
    } catch (error) {
      console.error(
        "Error during OAuth2 process:",
        error.response?.data || error.message
      );
      return res
        .status(500)
        .json({ error: "Failed to authenticate with Discord." });
    }
  } else {
    console.error("No authorization code provided.");
    return res.status(400).json({ error: "Authorization code missing." });
  }
});

// Refresh Token Function
async function refreshAccessToken(userId) {
  try {
    const { refreshToken } = userTokens[userId];
    const formData = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });

    const response = await axios.post(
      "https://discord.com/api/v10/oauth2/token",
      formData.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    userTokens[userId].accessToken = response.data.access_token;
    console.log(`Access token refreshed for user ${userId}.`);
    return response.data.access_token;
  } catch (error) {
    console.error(
      "Error refreshing access token:",
      error.response?.data || error.message
    );
    throw error;
  }
}

// API Endpoint to Post Data to a Channel
app.post("/api/post-to-channel", async (req, res) => {
  const { accessToken, refreshToken, channelId, messageContent } = req.body;

  if (!accessToken || !refreshToken || !channelId || !messageContent) {
    return res.status(400).json({
      error:
        "Missing required fields: accessToken, refreshToken, channelId, messageContent.",
    });
  }

  // Function to send a message to the channel
  async function sendMessage(token, channelId, content) {
    try {
      const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
      const botMessagingResponse = await axios.post(
        url,
        { content },
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );
      console.log("bot messaging response:", botMessagingResponse);
      console.log("Message sent successfully!");
      return res.status(200).json({ message: "Message sent successfully!" });
    } catch (error) {
      if (error.response?.status === 401) {
        console.log("Access token expired. Attempting to refresh...");
        return await refreshAccessTokenAndRetry();
      } else {
        console.error(
          "Error sending message:",
          error.response?.data || error.message
        );
        return res.status(500).json({
          error: "Failed to send the message.",
          details: error.response?.data || error.message,
        });
      }
    }
  }

  // Function to refresh the access token
  async function refreshAccessTokenAndRetry() {
    try {
      const formData = new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });

      const response = await axios.post(
        "https://discord.com/api/v10/oauth2/token",
        formData.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      const newAccessToken = response.data.access_token;

      console.log("Access token refreshed successfully.");
      await sendMessage(newAccessToken, channelId, messageContent);
    } catch (error) {
      console.error(
        "Error refreshing access token:",
        error.response?.data || error.message
      );
      return res.status(500).json({
        error: "Failed to refresh access token.",
        details: error.response?.data || error.message,
      });
    }
  }

  // Attempt to send the message with the provided access token
  await sendMessage(accessToken, channelId, messageContent);
});

// Send Message with User's Access Token
async function sendMessageWithUserToken(userId, channelId, messageContent) {
  try {
    const accessToken = userTokens[userId].accessToken;
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

    await axios.post(
      url,
      { content: messageContent },
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    console.log("Message sent successfully!");
  } catch (error) {
    if (error.response?.status === 401) {
      console.log("Access token expired. Refreshing...");
      const newAccessToken = await refreshAccessToken(userId);
      await sendMessageWithUserToken(userId, channelId, messageContent); // Retry with new token
    } else {
      console.error(
        "Error sending message:",
        error.response?.data || error.message
      );
    }
  }
}

// Bot Message Event Listener
botClient.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  if (message.content.startsWith("create")) {
    const url = message.content.split("create")[1]?.trim();
    const userId = message.author.id; // User ID from the message

    if (!userTokens[userId]) {
      return message.reply("You need to authorize first! Visit: " + authUrl);
    }

    if (!url) {
      return message.reply("Please provide a URL after the 'create' command.");
    }

    const shortId = `sm${Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0")}`;
    const channelId = message.channel.id;

    await sendMessageWithUserToken(
      userId,
      channelId,
      `Generated Short ID for ${url}: ${shortId}`
    );
    return;
  }

  message.reply("Hi from bot");
});

// Start Bot Client
botClient.login(discordBotToken);

// Start Server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
