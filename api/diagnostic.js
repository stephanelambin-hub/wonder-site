/**
 * WONDER - Auto-diagnostic du niveau de service
 * Fonction serverless Vercel : enregistre chaque diagnostic dans Airtable.
 *
 * Variables d'environnement (Vercel > Settings > Environment Variables) :
 *   AIRTABLE_TOKEN           déjà utilisé par /api/evaluation (scope data.records:write
 *                            à étendre à la base des diagnostics)
 *   AIRTABLE_DIAG_BASE_ID    base Airtable qui contient la table "Diagnostics"
 *
 * Table "Diagnostics", champs attendus (noms exacts) :
 *   Prénom, Nom, Établissement, Fonction, Téléphone (texte)
 *   Email (email)
 *   Score (nombre, 0 à 100)
 *   Niveau, Priorité 1, Priorité 2, Orientation, Satisfaction clients (texte)
 *   Réponses (texte long)
 *   Statut (sélection unique, ex. "À rappeler", "RDV pris", "Sans suite")
 *
 * Route : POST /api/diagnostic -> { ok: true, id }
 * La page affiche le résultat même si l'enregistrement échoue.
 */

const BASE_ID = process.env.AIRTABLE_DIAG_BASE_ID;
const TOKEN   = process.env.AIRTABLE_TOKEN;
const TABLE   = 'Diagnostics';

function texte(v, max = 300) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function lireCorps(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); }
  }
  return new Promise(resolve => {
    let brut = '';
    req.on('data', c => { brut += c; if (brut.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(brut || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
  if (!TOKEN || !BASE_ID) return res.status(500).json({ error: 'Configuration Airtable manquante' });

  const d = await lireCorps(req);
  const email = texte(d.email, 200);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Email invalide' });

  const score = Number(d.score);
  const fields = {
    'Prénom': texte(d.prenom, 80),
    'Nom': texte(d.nom, 80),
    'Établissement': texte(d.etablissement, 160),
    'Fonction': texte(d.fonction, 120),
    'Téléphone': texte(d.telephone, 40),
    'Email': email,
    'Score': Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null,
    'Niveau': texte(d.niveau, 60),
    'Priorité 1': texte(d.priorite1, 80),
    'Priorité 2': texte(d.priorite2, 80),
    'Orientation': texte(d.orientation, 80),
    'Satisfaction clients': texte(d.satisfaction, 40),
    'Réponses': texte(d.reponses, 4000),
    'Statut': 'À rappeler'
  };

  try {
    const r = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields }], typecast: true })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'Airtable', detail: j && j.error });
    return res.status(200).json({ ok: true, id: j.records && j.records[0] && j.records[0].id });
  } catch (e) {
    return res.status(502).json({ error: 'Enregistrement impossible' });
  }
};
