import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import authRoutes from "./routes/auth.routes.js";
import leadsRoutes from "./routes/leads.routes.js";
import distRoutes from "./routes/distribution.routes.js";
import msgRoutes from "./routes/messages.routes.js";
import metaWebhook from "./routes/meta.webhook.js";
import uazapiWebhook from "./routes/uazapi.webhook.js";
import { mailConfigured } from "./services/mail.js";
import { bootstrap } from "./bootstrap.js";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "con-crm" }));

// Páginas públicas do cadastro (servidas pelo próprio backend, para o link ser um só).
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use(express.static(publicDir, { extensions: ["html"] }));
app.get("/", (_req, res) => res.redirect("/cadastro"));
app.get("/cadastro", (_req, res) => res.sendFile(path.join(publicDir, "cadastro.html")));
app.get("/definir-senha", (_req, res) => res.sendFile(path.join(publicDir, "definir-senha.html")));

app.use("/auth", authRoutes);
app.use("/leads", leadsRoutes);
app.use("/distribution", distRoutes);
app.use("/", msgRoutes);              // POST /leads/:id/messages
app.use("/webhooks", metaWebhook);    // GET/POST /webhooks/meta
app.use("/webhooks", uazapiWebhook);  // POST /webhooks/uazapi

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  const org = bootstrap();
  const base = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
  console.log(`Con CRM backend rodando — org: ${org.name}`);
  console.log(`Link de cadastro dos corretores: ${base}/cadastro?c=${org.adm_code}`);
  if (!mailConfigured()) console.log("Atenção: e-mail não configurado (RESEND_API_KEY/MAIL_FROM). Os links de confirmação vão aparecer aqui no log.");
});
