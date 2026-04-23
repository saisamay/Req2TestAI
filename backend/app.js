const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");

const { cleanText, smartChunk } = require("./src/utils/textProcessor");
const { extractRequirements } = require("./src/services/requirementExtractor");

const app = express();
app.use(cors());

// storage config
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, "uploads"));
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + path.extname(file.originalname);
    cb(null, uniqueName);
  },
});

const upload = multer({ storage: storage });

app.post("/upload", upload.any(), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const filePath = req.files[0].path;

    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdfParse(dataBuffer);

    const cleanedText = cleanText(data.text);

    // ✅ use smart chunking
    const chunks = smartChunk(cleanedText);

    // ✅ extract requirements
    const requirements = extractRequirements(chunks);

    // ✅ single response
    res.json({
      message: "Processing successful",
      totalChunks: chunks.length,
      totalRequirements: requirements.length,
      sampleRequirement: requirements.slice(0, 5),
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Processing failed" });
  }
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});