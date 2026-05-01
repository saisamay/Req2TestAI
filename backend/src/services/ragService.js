const OpenAI       = require("openai");
const { Pinecone } = require("@pinecone-database/pinecone");
const knowledge    = require("../data/testingKnowledge.json");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pc     = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

const INDEX_NAME      = "testing-knowledge";
const EMBEDDING_MODEL = "text-embedding-3-small";
const DIMENSION       = 1536;

let pineconeIndex  = null;
let initialized    = false;
let inMemoryStore  = null; // fallback if Pinecone fails

// ---------- COSINE SIMILARITY (fallback) ----------
function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ---------- INIT ----------
async function initRAG() {
  if (initialized) return;

  try {
    console.log("[RAG] Connecting to Pinecone...");

    // Connect to existing index (created in Pinecone dashboard)
    pineconeIndex = pc.index(INDEX_NAME);

    // Check how many vectors are stored
    const stats       = await pineconeIndex.describeIndexStats();
    const storedCount = stats.totalRecordCount ?? 0;

    console.log(`[RAG] Pinecone index has ${storedCount} vectors, knowledge base has ${knowledge.length} entries`);

    if (storedCount < knowledge.length) {
      console.log("[RAG] Upserting knowledge base to Pinecone...");

      // Generate embeddings for all knowledge entries
      const texts = knowledge.map(k =>
        `${k.pattern}: ${k.description}. Test strategies: ${k.test_strategies.join(". ")}`
      );

      const embRes = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: texts
      });

      if (!embRes.data || embRes.data.length === 0) {
        throw new Error("OpenAI returned no embeddings");
      }

      const vectors = knowledge.map((k, i) => ({
        id:     k.id,
        values: embRes.data[i].embedding,
        metadata: {
          category:        k.category,
          pattern:         k.pattern,
          description:     k.description,
          test_strategies: k.test_strategies.join(" | ")
        }
      }));

      console.log(`[RAG] Upserting ${vectors.length} vectors...`);

      // Upsert in batches of 100
      for (let i = 0; i < vectors.length; i += 100) {
        const batch = vectors.slice(i, i + 100);
        if (batch.length > 0) {
          await pineconeIndex.upsert(batch);
        }
      }

      console.log(`[RAG] ${vectors.length} vectors stored in Pinecone`);
    } else {
      console.log(`[RAG] Pinecone ready — ${storedCount} vectors already stored`);
    }

    initialized = true;

  } catch (err) {
    console.error("[RAG] Pinecone init failed, falling back to in-memory:", err.message);
    await initInMemoryFallback();
  }
}

// ---------- IN-MEMORY FALLBACK ----------
async function initInMemoryFallback() {
  console.log("[RAG] Initializing in-memory fallback...");

  const texts = knowledge.map(k =>
    `${k.pattern}: ${k.description}. Test strategies: ${k.test_strategies.join(". ")}`
  );

  const embRes = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts
  });

  inMemoryStore = knowledge.map((k, i) => ({
    ...k,
    embedding: embRes.data[i].embedding
  }));

  initialized = true;
  console.log(`[RAG] In-memory fallback ready with ${inMemoryStore.length} entries`);
}

// ---------- SINGLE RETRIEVE ----------
async function retrieveTestPatterns(requirementText, topK = 3) {
  if (!initialized) await initRAG();

  const embRes = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: [requirementText]
  });

  const reqEmbedding = embRes.data[0].embedding;

  // Use Pinecone if available, else in-memory
  if (pineconeIndex && !inMemoryStore) {
    const results = await pineconeIndex.query({
      vector:          reqEmbedding,
      topK,
      includeMetadata: true
    });
    return results.matches.map(formatPineconeMatch);
  } else {
    return inMemoryStore
      .map(k => ({ ...k, score: cosineSimilarity(reqEmbedding, k.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(formatMemoryMatch);
  }
}

// ---------- BATCH RETRIEVE ----------
async function retrieveTestPatternsBatch(requirements, topK = 2) {
  if (!initialized) await initRAG();

  const embRes = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: requirements.map(r => r.text)
  });

  if (pineconeIndex && !inMemoryStore) {
    // Pinecone: parallel queries
    const queryResults = await Promise.all(
      embRes.data.map(e =>
        pineconeIndex.query({
          vector:          e.embedding,
          topK,
          includeMetadata: true
        })
      )
    );
    return queryResults.map(r => r.matches.map(formatPineconeMatch));
  } else {
    // In-memory: cosine similarity
    return embRes.data.map(e =>
      inMemoryStore
        .map(k => ({ ...k, score: cosineSimilarity(e.embedding, k.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(formatMemoryMatch)
    );
  }
}

// ---------- FORMATTERS ----------
function formatPineconeMatch(m) {
  return {
    id:              m.id,
    score:           m.score,
    category:        m.metadata.category,
    pattern:         m.metadata.pattern,
    description:     m.metadata.description,
    test_strategies: String(m.metadata.test_strategies).split(" | ")
  };
}

function formatMemoryMatch(k) {
  return {
    id:              k.id,
    score:           k.score,
    category:        k.category,
    pattern:         k.pattern,
    description:     k.description,
    test_strategies: k.test_strategies
  };
}

module.exports = { initRAG, retrieveTestPatterns, retrieveTestPatternsBatch };
