/**
 * WONDER - Évaluation de formation
 * Fonction serverless Vercel : sert la liste des sessions et enregistre les réponses dans Airtable.
 *
 * Variables d'environnement à définir dans Vercel (Settings > Environment Variables) :
 *   AIRTABLE_TOKEN    Personal Access Token Airtable, scopes data.records:read + data.records:write
 *   AIRTABLE_BASE_ID  appBs7YAeV2Ed3HxK   (base "WONDER Academy - Évaluations")
 *
 * Routes :
 *   GET  /api/evaluation   -> { sessions: [{ id, name }] }
 *   POST /api/evaluation   -> { ok: true, id }
 */

const BASE_ID   = process.env.AIRTABLE_BASE_ID || 'appBs7YAeV2Ed3HxK';
const TOKEN     = process.env.AIRTABLE_TOKEN;
const T_SESSION = 'Sessions';
const T_EVAL    = 'Évaluations';
const API       = 'https://api.airtable.com/v0';

// Les 10 échelles autorisées, valeurs de 1 à 4.
// Toute autre clé envoyée par le navigateur est ignorée.
const ECHELLES = [
  '1. Le formateur maîtrise son sujet',
  '2. Il a rendu la journée vivante et utile',
  "3. J'ai pu poser mes questions et être entendu",
  '4. Les supports utilisés étaient clairs et appropriés',
  '5. Le contenu correspondait à la réalité de mon métier',
  '6. Les objectifs annoncés ont été atteints',
  "7. J'ai appris quelque chose que je ne savais pas faire avant",
  '8. Je vois ce que je vais changer dans ma pratique dès demain',
  "9. L'accueil et les conditions matérielles étaient à la hauteur",
  '10. Globalement, je suis satisfait de cette formation'
];

const BESOIN_OK = ['Oui', 'Non'];

function airtable(chemin, options = {}) {
  return fetch(`${API}/${BASE_ID}/${chemin}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

function texte(v, max = 2000) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// Lecture du corps de requête, avec repli si Vercel ne l'a pas déjà parsé.
function lireCorps(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body)); } catch { return Promise.resolve({}); }
  }
  return new Promise(resolve => {
    let brut = '';
    req.on('data', c => { brut += c; if (brut.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(brut || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!TOKEN) return res.status(500).json({ error: 'AIRTABLE_TOKEN manquant' });

  /* ---------------- Liste des sessions ---------------- */
  if (req.method === 'GET') {
    try {
      // encodeURIComponent plutôt que URLSearchParams : Airtable attend %20 et non + pour les espaces.
      const e = encodeURIComponent;
      const params = [
        `fields%5B%5D=${e('Session')}`,
        // Seules les sessions ouvertes aux réponses sont exposées.
        `filterByFormula=${e("OR({Statut}='En cours',{Statut}='Terminée')")}`,
        `sort%5B0%5D%5Bfield%5D=${e('Date de début')}`,
        `sort%5B0%5D%5Bdirection%5D=desc`,
        `pageSize=50`
      ].join('&');

      const r = await airtable(`${e(T_SESSION)}?${params}`);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
      const j = await r.json();

      const sessions = (j.records || [])
        .filter(rec => rec.fields && rec.fields['Session'])
        .map(rec => ({ id: rec.id, name: rec.fields['Session'] }));

      return res.status(200).json({ sessions });
    } catch (err) {
      console.error('[evaluation] GET', err);
      return res.status(500).json({
        error: 'Lecture des sessions impossible',
        diagnostic: String((err && err.message) || err).slice(0, 300),
        baseUtilisee: BASE_ID,
        longueurDuJeton: (TOKEN || '').length
      });
    }
  }

  /* ---------------- Enregistrement d'une réponse ---------------- */
  if (req.method === 'POST') {
    try {
      const body = await lireCorps(req);
      const fields = {};

      // Session : lien vers la table Sessions, ou saisie libre à rattacher plus tard.
      if (typeof body.sessionId === 'string' && /^rec[A-Za-z0-9]{14}$/.test(body.sessionId)) {
        fields['Session'] = [body.sessionId];
      } else if (!texte(body.sessionLibre)) {
        return res.status(400).json({ error: 'Session manquante' });
      }

      fields['Participant'] = texte(body.participant, 100) || 'Anonyme';

      const fonction = texte(body.fonction, 120);
      if (fonction) fields['Fonction'] = fonction;

      const libre = texte(body.sessionLibre, 160);
      if (libre) fields['Session déclarée (hors liste)'] = libre;

      // Échelles de 1 à 4
      const echelles = body.echelles || {};
      for (const nom of ECHELLES) {
        const v = Number(echelles[nom]);
        if (Number.isInteger(v) && v >= 1 && v <= 4) fields[nom] = v;
      }

      // Recommandation de 0 à 10. Le typeof est indispensable : sans réponse le navigateur
      // envoie null, et Number(null) vaut 0, ce qui enregistrerait un détracteur fantôme.
      if (typeof body.nps === 'number' && Number.isInteger(body.nps) && body.nps >= 0 && body.nps <= 10) {
        fields['Recommandation (0 à 10)'] = body.nps;
      }

      // Besoin spécifique
      if (BESOIN_OK.includes(body.besoin)) {
        fields['Difficulté liée à un besoin spécifique'] = body.besoin;
        if (body.besoin === 'Oui') {
          const p = texte(body.precision);
          if (p) fields['Précision sur le besoin spécifique'] = p;
        }
      }

      // Champs libres
      const libres = {
        'Le moment fort de la journée':      body.moment,
        'Ce que je change dès demain':       body.demain,
        "Ce qu'on aurait pu faire autrement": body.autrement
      };
      for (const [nom, v] of Object.entries(libres)) {
        const t = texte(v);
        if (t) fields[nom] = t;
      }

      const r = await airtable(encodeURIComponent(T_EVAL), {
        method: 'POST',
        body: JSON.stringify({ records: [{ fields }], typecast: true })
      });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 300));
      const j = await r.json();

      return res.status(200).json({ ok: true, id: j.records?.[0]?.id || null });
    } catch (err) {
      console.error('[evaluation] POST', err);
      return res.status(500).json({ error: 'Enregistrement impossible' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Méthode non autorisée' });
};
