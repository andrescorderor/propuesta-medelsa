import fs from 'node:fs/promises';
import path from 'node:path';

const PM_STATE_PATH = path.resolve('ops-data/pm-state.json');
const CLIENT_PORTAL_PATH = path.resolve('ops-data/client-portal.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GITHUB_TOKEN = process.env.PORTAL_SYNC_TOKEN || process.env.GITHUB_TOKEN || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function formatDateEs(date = new Date()) {
  return date.toLocaleDateString('es-MX', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'America/Mexico_City',
  });
}

async function fetchRecentCommits(codeRepo) {
  if (!codeRepo) return [];
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'uanify-ai-pm-agent',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(`https://api.github.com/repos/${codeRepo}/commits?per_page=12`, { headers });
  if (!res.ok) {
    console.warn(`No se pudieron leer commits de ${codeRepo}: HTTP ${res.status}`);
    return [];
  }
  const list = await res.json();
  return list.map((c) => ({
    sha: c.sha?.slice(0, 7) || '',
    date: c.commit?.author?.date?.slice(0, 10) || '',
    message: (c.commit?.message || '').split('\n')[0],
  }));
}

function buildDeterministicPortal(pmState) {
  const p = pmState.project;
  return {
    meta: {
      clientName: p.clientName,
      projectName: p.projectName,
      scopeLabel: p.scopeLabel,
      location: p.location,
      healthStatus: p.healthStatus,
      healthTone: p.healthTone,
      lastUpdated: formatDateEs(),
      progressPercent: Number(p.progressPercent) || 0,
      currentPhase: p.currentPhase,
      targetGoLive: p.targetGoLive,
      hostingCost: '$0 USD / mes',
    },
    phases: pmState.phases,
    modules: pmState.modules,
    clientInputs: pmState.clientInputs,
    links: {
      demoUrl: 'https://architechts.vercel.app/',
      demoLabel: 'Ver Prototipo Conceptual Inicial',
      proposalUrl: 'https://andrescorderor.github.io/propuesta-medelsa/',
      proposalLabel: 'Ver Propuesta Comercial',
    },
    nextSession: pmState.nextSession,
    agreements: pmState.agreements,
    support: {
      company: 'Uanify',
      tagline: 'Ingeniería de Software e IA Estratégica',
      website: 'https://uanify.com/',
      email: 'info@uanify.com',
      phone: '+52 477 520 2961',
      location: 'León, Guanajuato · México',
    },
  };
}

async function refineWithGemini(basePortal, pmState, commits) {
  if (!GEMINI_API_KEY) {
    console.log('GEMINI_API_KEY no definida; usando sincronización determinística sin IA.');
    return { portal: basePortal, summary: 'Sincronización directa (sin GEMINI_API_KEY configurada).' };
  }

  const prompt = `Eres el Project Manager Ejecutivo de Uanify para el proyecto "${pmState.project.projectName}" del cliente "${pmState.project.clientName}".

Tu tarea es generar el JSON actualizado para el PORTAL PÚBLICO DEL CLIENTE (ops-data/client-portal.json), combinando:
1. El estado interno del PM (fases, módulos, insumos del cliente, notas de reunión).
2. Los commits recientes del repositorio de código.

REGLAS ESTRICTAS DE SEGURIDAD Y ESTILO:
- Devuelve EXCLUSIVAMENTE JSON válido (sin bloques markdown, sin comentarios) con exactamente estas 2 llaves raíz: { "portal": <objeto con exactamente las mismas claves que basePortal>, "executiveSummary": "<resumen interno de 1-2 frases para Uanify sobre qué se actualizó>" }.
- Lenguaje 100% ejecutivo y de negocio en español.
- NUNCA uses la palabra "despacho"; usa siempre "Estudio" o "estudio de arquitectura".
- NUNCA menciones finanzas internas, tarifas, montos de pago pendientes, IA, Gemini, GitHub, commits, archivos de código ni tareas internas privadas en el objeto "portal".
- Respeta el progreso y estatus reales del PM: no marques módulos como "Listo" o "Aprobado" si en pmState están en "Pendiente" o "Por Definir en Reunión", a menos que las notas de reunión o commits recientes demuestren explícitamente que esa etapa ya se aprobó o completó.
- Mantén intactos los datos de "support" (Uanify) y "links".

basePortal:
${JSON.stringify(basePortal)}

notasDeReunionInternas:
${pmState.meetingNotes || 'Sin notas nuevas.'}

tareasInternasCompletadas:
${JSON.stringify((pmState.internalTasks || []).filter((t) => t.done).map((t) => t.title))}

commitsRecientesDelCodigo:
${JSON.stringify(commits)}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn(`Gemini API falló (${res.status}): ${errText}. Usando respaldo determinístico.`);
    return { portal: basePortal, summary: `Respaldo determinístico (Gemini HTTP ${res.status}).` };
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const parsed = JSON.parse(rawText);

  if (!parsed?.portal?.meta || !Array.isArray(parsed?.portal?.phases)) {
    throw new Error('Respuesta de Gemini incompleta; se aborta para proteger el portal.');
  }

  parsed.portal.support = basePortal.support;
  parsed.portal.links = basePortal.links;
  parsed.portal.meta.lastUpdated = formatDateEs();

  return {
    portal: parsed.portal,
    summary: parsed.executiveSummary || 'Portal del cliente actualizado por Agente PM (Gemini).',
  };
}

async function main() {
  const pmState = JSON.parse(await fs.readFile(PM_STATE_PATH, 'utf8'));
  const commits = await fetchRecentCommits(pmState.project.codeRepo);
  const basePortal = buildDeterministicPortal(pmState);
  const { portal, summary } = await refineWithGemini(basePortal, pmState, commits);

  await fs.writeFile(CLIENT_PORTAL_PATH, JSON.stringify(portal, null, 2) + '\n', 'utf8');

  pmState.project.lastUpdated = formatDateEs();
  pmState.aiSync = {
    lastRunAt: new Date().toISOString(),
    lastCommitSha: commits[0]?.sha || '',
    lastSummary: summary,
  };
  await fs.writeFile(PM_STATE_PATH, JSON.stringify(pmState, null, 2) + '\n', 'utf8');
  console.log('Sync completado:', summary);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
