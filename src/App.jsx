import { useState, useEffect, useMemo } from "react";

// ─── Helpers ────────────────────────────────────────────────────────────────

const WEEKDAYS = ["domingo","segunda","terça","quarta","quinta","sexta","sábado"];

function isWeekend(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay()
  return day === 0 || day === 6;
}

function calcPaymentDate(plantaoDate, hospital) {
  const d = new Date(plantaoDate + "T12:00:00");
  const year = d.getFullYear();
  const month = d.getMonth(); // 0-indexed

  if (hospital.paymentType === "same_month") {
    const payDay = hospital.payDay;
    return new Date(year, month, payDay);
  } else if (hospital.paymentType === "next_month") {
    const payDay = hospital.payDay;
    return new Date(year, month + 1, payDay);
  } else if (hospital.paymentType === "45_after_month") {
    // 45 days after end of the month
    const endOfMonth = new Date(year, month + 1, 0);
    const pay = new Date(endOfMonth);
    pay.setDate(pay.getDate() + 45);
    return pay;
  } else if (hospital.paymentType === "window_next_month") {
    // Window: between payDayStart and payDayEnd of next month (use start)
    return new Date(year, month + 1, hospital.payDayStart);
  }
  return new Date(year, month + 1, hospital.payDay || 10);
}

const SHIFT_HOURS = 12;

function calcShiftValue(dateStr, hospital) {
  const weekend = isWeekend(dateStr);
  if (hospital.id === "HX") {
    const d = new Date(dateStr + "T12:00:00");
    const isNewPeriod = d.getFullYear() > 2026 || (d.getFullYear() === 2026 && d.getMonth() >= 5);
    if (isNewPeriod) return weekend ? 1900 : 1800;
    else return 1700;
  }
  if (hospital.valueWeekend !== undefined && weekend) return hospital.valueWeekend;
  return hospital.value;
}

function calcValueByHours(fullValue, hours) {
  const h = Math.min(Math.max(Number(hours) || SHIFT_HOURS, 0), SHIFT_HOURS);
  return Math.round((fullValue / SHIFT_HOURS) * h * 100) / 100;
}

function fmtDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function fmtMoney(v) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function monthLabel(year, month) {
  const d = new Date(year, month, 1);
  return d.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
}

function payDateStr(d) {
  return d.toISOString().slice(0, 10);
}

function isOverdue(payDateIso) {
  return payDateIso < today();
}

function googleCalendarUrl(title, dateIso, description) {
  const d = new Date(dateIso + "T09:00:00");
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (dt) =>
    `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T090000`;
  const end = new Date(d);
  end.setHours(10);
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", title);
  url.searchParams.set("dates", `${fmt(d)}/${fmt(end)}`);
  url.searchParams.set("details", description);
  return url.toString();
}

// ─── Google Sheets OAuth + Export ────────────────────────────────────────────

// IMPORTANT: Para usar a exportação para Sheets, você precisa de um Client ID do Google.
// Passos rápidos:
//   1. Acesse console.cloud.google.com → crie um projeto
//   2. Ative a API "Google Sheets API"
//   3. Crie credenciais OAuth 2.0 → Aplicativo da Web
//   4. Em "Origens JS autorizadas" coloque a URL onde roda esse app
//   5. Cole o Client ID abaixo
const GOOGLE_CLIENT_ID = "954449084376-dl0s0phihikuepcj47f8us18i0o1m4ug.apps.googleusercontent.com";

const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file";

function getGoogleToken() {
  const tok = sessionStorage.getItem("gsheets_token");
  const exp = sessionStorage.getItem("gsheets_token_exp");
  if (tok && exp && Date.now() < Number(exp)) return tok;
  return null;
}

function saveGoogleToken(token, expiresIn) {
  sessionStorage.setItem("gsheets_token", token);
  sessionStorage.setItem("gsheets_token_exp", String(Date.now() + expiresIn * 1000 - 60000));
}

function clearGoogleToken() {
  sessionStorage.removeItem("gsheets_token");
  sessionStorage.removeItem("gsheets_token_exp");
}

function loginWithGoogle() {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_CLIENT_ID) {
      reject(new Error("CLIENT_ID_MISSING"));
      return;
    }

    if (!window.google) {
      reject(new Error("A biblioteca do Google não foi carregada. Verifique o index.html."));
      return;
    }

    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: (tokenResponse) => {
        if (tokenResponse && tokenResponse.access_token) {
          saveGoogleToken(tokenResponse.access_token, tokenResponse.expires_in || 3600);
          resolve(tokenResponse.access_token);
        } else {
          reject(new Error("Falha ao obter o token de acesso."));
        }
      },
      error_callback: (error) => {
        reject(new Error("Popup fechado ou erro de autenticação."));
      }
    });

    client.requestAccessToken();
  });
}

async function ensureToken() {
  const existing = getGoogleToken();
  if (existing) return existing;
  return await loginWithGoogle();
}

const SPREADSHEET_NAME = "🩺 Plantões";
const SPREADSHEET_ID_KEY = "gsheets_spreadsheet_id";

async function findOrCreateSpreadsheet(token) {
  // Tenta usar o ID salvo localmente
  const savedId = localStorage.getItem(SPREADSHEET_ID_KEY);
  if (savedId) {
    // Verifica se ainda existe
    const check = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${savedId}?fields=spreadsheetId`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (check.ok) return savedId;
    // Se não existe mais, remove o ID salvo e cria uma nova
    localStorage.removeItem(SPREADSHEET_ID_KEY);
  }

  // Busca no Drive por uma planilha com esse nome
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=name='${SPREADSHEET_NAME}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false&fields=files(id,name)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const searchData = await searchRes.json();
  if (searchData.files && searchData.files.length > 0) {
    const id = searchData.files[0].id;
    localStorage.setItem(SPREADSHEET_ID_KEY, id);
    return id;
  }

  // Não existe — cria nova planilha
  const createRes = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ properties: { title: SPREADSHEET_NAME } }),
  });
  if (!createRes.ok) {
    const err = await createRes.json();
    throw new Error(err.error?.message || "Erro ao criar planilha");
  }
  const created = await createRes.json();
  localStorage.setItem(SPREADSHEET_ID_KEY, created.spreadsheetId);
  return created.spreadsheetId;
}

async function exportToSheets(shifts, hospitals, year, month) {
  const token = await ensureToken();
  const tabName = new Date(year, month, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  // Capitaliza primeira letra
  const tabTitle = tabName.charAt(0).toUpperCase() + tabName.slice(1);

  const spreadsheetId = await findOrCreateSpreadsheet(token);

  // Busca abas existentes
  const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meta = await metaRes.json();
  const existingSheets = meta.sheets || [];
  const existingTab = existingSheets.find(s => s.properties.title === tabTitle);

  let tabSheetId;

  if (existingTab) {
    // Aba já existe — limpa o conteúdo pra reescrever atualizado
    tabSheetId = existingTab.properties.sheetId;
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tabTitle)}:clear`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } else {
    // Cria nova aba
    const addRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: tabTitle } } }],
      }),
    });
    const addData = await addRes.json();
    tabSheetId = addData.replies[0].addSheet.properties.sheetId;

    // Remove a aba padrão "Plan1" se for a única aba original
    const defaultSheet = existingSheets.find(s => s.properties.title === "Plan1" || s.properties.title === "Sheet1" || s.properties.title === "Página1");
    if (defaultSheet && existingSheets.length === 1) {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: defaultSheet.properties.sheetId } }] }),
      });
    }
  }

  // Monta os dados
  const hospital = (id) => hospitals.find((h) => h.id === id) || { name: id, emoji: "" };
  const monthShifts = shifts
    .filter((sh) => { const d = new Date(sh.date + "T12:00:00"); return d.getFullYear() === year && d.getMonth() === month; })
    .sort((a, b) => a.date.localeCompare(b.date));

  const header = [["Data", "Dia da Semana", "Hospital", "Horas", "Valor (R$)", "Data Pagamento", "Status"]];
  const rows = monthShifts.map((sh) => {
    const h = hospital(sh.hospitalId);
    const d = new Date(sh.date + "T12:00:00");
    const payDate = calcPaymentDate(sh.date, h);
    return [
      fmtDate(sh.date),
      WEEKDAYS[d.getDay()],
      `${h.emoji} ${h.name}`,
      sh.hours ?? SHIFT_HOURS,
      sh.value,
      fmtDate(payDateStr(payDate)),
      sh.received ? "✓ Recebido" : "Pendente",
    ];
  });

  const total = monthShifts.reduce((a, s) => a + (s.value || 0), 0);
  const values = [...header, ...rows, [""], ["", "", "TOTAL", "", total, "", ""]];

  // Escreve os dados na aba
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(tabTitle)}!A1?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    }
  );

  // Formata
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          repeatCell: {
            range: { sheetId: tabSheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.49, green: 0.42, blue: 0.97 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
              },
            },
            fields: "userEnteredFormat(backgroundColor,textFormat)",
          },
        },
        {
          repeatCell: {
            range: { sheetId: tabSheetId, startRowIndex: rows.length + 2, endRowIndex: rows.length + 3 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat(textFormat)",
          },
        },
        { autoResizeDimensions: { dimensions: { sheetId: tabSheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 7 } } },
      ],
    }),
  });

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

// ─── Default hospitals ───────────────────────────────────────────────────────

const DEFAULT_HOSPITALS = [
  {
    id: "SANTA_HELENA",
    name: "Santa Helena",
    color: "#f472b6",
    emoji: "🩷",
    value: 1600,
    valueWeekend: 1700,
    paymentType: "next_month",
    payDay: 22,
    payDayLabel: "Dia 22 do mês seguinte",
  },
  {
    id: "RESIDENCIA",
    name: "Residência",
    color: "#34d399",
    emoji: "💚",
    value: 4100,
    valueWeekend: 4100,
    paymentType: "next_month",
    payDay: 5,
    payDayLabel: "Dia 05 do mês seguinte",
  },
  {
    id: "HX",
    name: "HX",
    color: "#60a5fa",
    emoji: "🔵",
    value: 1800,
    valueWeekend: 1900,
    paymentType: "45_after_month",
    payDayLabel: "45 dias após fim do mês",
  },
  {
    id: "UBS",
    name: "UBS",
    color: "#fbbf24",
    emoji: "💛",
    value: 1200,
    valueWeekend: 1200,
    paymentType: "45_after_month",
    payDayLabel: "45 dias após fim do mês",
  },
  {
    id: "SAO_LUIZ",
    name: "São Luiz São Caetano",
    color: "#a78bfa",
    emoji: "🟣",
    value: 2000,
    valueWeekend: 2300,
    paymentType: "window_next_month",
    payDayStart: 20,
    payDayEnd: 24,
    payDayLabel: "Entre dias 20–24 do mês seguinte",
  },
  {
    id: "MARCIA_BRAIDO",
    name: "Márcia Braido",
    color: "#fb923c",
    emoji: "🧡",
    value: 1500,
    valueWeekend: 1500,
    paymentType: "next_month",
    payDay: 20,
    payDayLabel: "Dia 20 do mês seguinte",
  },
];

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,wght@0,300;0,400;0,500;1,300&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0a0a0f;
    --surface: #13131a;
    --surface2: #1c1c28;
    --surface3: #242435;
    --border: #2a2a3d;
    --accent: #7c6af7;
    --accent2: #f472b6;
    --text: #f0f0f8;
    --text2: #8888aa;
    --text3: #555570;
    --green: #34d399;
    --red: #f87171;
    --yellow: #fbbf24;
    --radius: 14px;
    --radius-sm: 8px;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    font-size: 14px;
    line-height: 1.5;
    min-height: 100vh;
  }

  .app {
    max-width: 900px;
    margin: 0 auto;
    padding: 0 0 80px 0;
  }

  /* Header */
  .header {
    padding: 28px 24px 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .header-title {
    font-family: 'Syne', sans-serif;
    font-size: 22px;
    font-weight: 800;
    letter-spacing: -0.5px;
    background: linear-gradient(135deg, #7c6af7, #f472b6);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .header-sub {
    font-size: 12px;
    color: var(--text3);
    margin-top: 2px;
    font-family: 'DM Sans', sans-serif;
    -webkit-text-fill-color: var(--text3);
  }

  /* Nav */
  .nav {
    display: flex;
    gap: 4px;
    padding: 20px 24px 0;
    border-bottom: 1px solid var(--border);
    padding-bottom: 0;
  }
  .nav-btn {
    font-family: 'Syne', sans-serif;
    font-size: 13px;
    font-weight: 600;
    padding: 10px 16px;
    border: none;
    background: none;
    color: var(--text3);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
    border-radius: 8px 8px 0 0;
    letter-spacing: 0.3px;
  }
  .nav-btn:hover { color: var(--text2); }
  .nav-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    background: rgba(124,106,247,0.06);
  }

  /* Content */
  .content { padding: 24px; }

  /* Cards */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: var(--surface3); }
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
    margin-bottom: 20px;
  }

  /* Stat cards */
  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px 20px;
  }
  .stat-card.red { border-color: rgba(248,113,113,0.4); background: rgba(248,113,113,0.06); }
  .stat-label { font-size: 11px; color: var(--text3); text-transform: uppercase; letter-spacing: 1px; font-weight: 500; }
  .stat-label.red { color: var(--red); }
  .stat-value { font-family: 'Syne', sans-serif; font-size: 22px; font-weight: 700; margin-top: 4px; }
  .stat-sub { font-size: 11px; color: var(--text3); margin-top: 2px; }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 16px;
    border-radius: var(--radius-sm);
    font-family: 'DM Sans', sans-serif;
    font-size: 13px;
    font-weight: 500;
    border: none;
    cursor: pointer;
    transition: all 0.18s;
  }
  .btn-primary {
    background: linear-gradient(135deg, #7c6af7, #6c5ce7);
    color: #fff;
    box-shadow: 0 2px 12px rgba(124,106,247,0.35);
  }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 4px 18px rgba(124,106,247,0.45); }
  .btn-green {
    background: rgba(52,211,153,0.15);
    color: var(--green);
    border: 1px solid rgba(52,211,153,0.3);
  }
  .btn-green:hover { background: rgba(52,211,153,0.25); }
  .btn-ghost {
    background: var(--surface2);
    color: var(--text2);
    border: 1px solid var(--border);
  }
  .btn-ghost:hover { background: var(--surface3); color: var(--text); }
  .btn-icon {
    width: 30px; height: 30px;
    padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.18s;
    font-size: 14px;
    color: var(--text2);
  }
  .btn-icon:hover { background: var(--surface3); color: var(--text); }
  .btn-icon.confirm { background: rgba(52,211,153,0.12); border-color: rgba(52,211,153,0.3); color: var(--green); }
  .btn-icon.confirm:hover { background: rgba(52,211,153,0.25); }
  .btn-icon.calendar { background: rgba(124,106,247,0.12); border-color: rgba(124,106,247,0.3); color: var(--accent); }
  .btn-icon.calendar:hover { background: rgba(124,106,247,0.25); }
  .btn-icon.edit { background: rgba(251,191,36,0.1); border-color: rgba(251,191,36,0.25); color: var(--yellow); }
  .btn-icon.edit:hover { background: rgba(251,191,36,0.2); }
  .btn-icon.delete { background: rgba(248,113,113,0.1); border-color: rgba(248,113,113,0.25); color: var(--red); }
  .btn-icon.delete:hover { background: rgba(248,113,113,0.2); }

  /* Shift item */
  .shift-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    transition: border-color 0.2s;
  }
  .shift-item:hover { border-color: var(--surface3); }
  .shift-item.received { opacity: 0.5; }
  .shift-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .shift-info { flex: 1; min-width: 0; }
  .shift-name { font-family: 'Syne', sans-serif; font-size: 13px; font-weight: 600; }
  .shift-meta { font-size: 11px; color: var(--text3); margin-top: 1px; }
  .shift-value { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: var(--green); white-space: nowrap; }
  .shift-actions { display: flex; gap: 6px; flex-shrink: 0; }

  /* Overdue badge */
  .badge-overdue {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 99px;
    background: rgba(248,113,113,0.15);
    color: var(--red);
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .badge-soon {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 99px;
    background: rgba(251,191,36,0.15);
    color: var(--yellow);
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  .badge-ok {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 99px;
    background: rgba(52,211,153,0.12);
    color: var(--green);
    font-weight: 500;
  }

  /* Section header */
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
    margin-top: 22px;
  }
  .section-title {
    font-family: 'Syne', sans-serif;
    font-size: 15px;
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .section-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 99px;
    background: rgba(248,113,113,0.15);
    color: var(--red);
    font-weight: 600;
  }

  /* Chart */
  .chart-bars {
    display: flex;
    align-items: flex-end;
    gap: 6px;
    height: 80px;
    padding: 8px 0 0;
  }
  .chart-bar-wrap { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; }
  .chart-bar {
    width: 100%;
    border-radius: 4px 4px 0 0;
    background: linear-gradient(180deg, #7c6af7, #6c5ce7);
    transition: height 0.4s cubic-bezier(.34,1.56,.64,1);
    min-height: 3px;
    cursor: pointer;
  }
  .chart-bar:hover { background: linear-gradient(180deg, #9f92f9, #7c6af7); }
  .chart-bar-label { font-size: 10px; color: var(--text3); }
  .chart-bar-value { font-size: 10px; color: var(--text2); font-weight: 500; }

  /* Modal */
  .modal-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.7);
    backdrop-filter: blur(4px);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 24px;
    width: 100%;
    max-width: 420px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.5);
  }
  .modal-title {
    font-family: 'Syne', sans-serif;
    font-size: 17px;
    font-weight: 700;
    margin-bottom: 18px;
  }

  /* Form */
  .form-group { margin-bottom: 14px; }
  .form-label { font-size: 11px; color: var(--text3); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 6px; display: block; }
  .form-input, .form-select {
    width: 100%;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    font-size: 14px;
    outline: none;
    transition: border-color 0.2s;
  }
  .form-input:focus, .form-select:focus { border-color: var(--accent); }
  .form-select option { background: var(--surface2); }

  /* Preview */
  .preview-box {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    margin-bottom: 16px;
  }
  .preview-row { display: flex; justify-content: space-between; align-items: center; }
  .preview-label { font-size: 12px; color: var(--text3); }
  .preview-value { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; }
  .preview-pay { font-size: 12px; color: var(--text2); margin-top: 4px; }

  /* Hospital card */
  .hospital-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .hospital-dot {
    width: 40px; height: 40px;
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px;
    flex-shrink: 0;
  }
  .hospital-info { flex: 1; }
  .hospital-name { font-family: 'Syne', sans-serif; font-size: 15px; font-weight: 700; }
  .hospital-detail { font-size: 12px; color: var(--text3); margin-top: 3px; }
  .hospital-values { text-align: right; }
  .hospital-val { font-family: 'Syne', sans-serif; font-size: 14px; font-weight: 700; color: var(--green); }
  .hospital-val-sub { font-size: 11px; color: var(--text3); }

  /* Fab */
  .fab {
    position: fixed;
    bottom: 24px; right: 24px;
    background: linear-gradient(135deg, #7c6af7, #f472b6);
    color: white;
    border: none;
    border-radius: 28px;
    padding: 14px 22px;
    font-family: 'Syne', sans-serif;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 6px 24px rgba(124,106,247,0.45);
    display: flex; align-items: center; gap: 8px;
    transition: all 0.2s;
    z-index: 50;
  }
  .fab:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(124,106,247,0.55); }

  .btn-sheets {
    background: rgba(52,211,153,0.12);
    color: var(--green);
    border: 1px solid rgba(52,211,153,0.3);
    font-family: 'Syne', sans-serif;
    font-weight: 600;
  }
  .btn-sheets:hover { background: rgba(52,211,153,0.22); transform: translateY(-1px); }
  .btn-sheets:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

  .export-box {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    margin-top: 20px;
  }
  .export-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .export-status { font-size: 12px; color: var(--text3); margin-top: 8px; }
  .export-status.success { color: var(--green); }
  .export-status.error { color: var(--red); }
  .export-link { color: var(--accent); text-decoration: underline; cursor: pointer; font-size: 12px; }

  .setup-warning {
    background: rgba(251,191,36,0.08);
    border: 1px solid rgba(251,191,36,0.25);
    border-radius: var(--radius-sm);
    padding: 12px 14px;
    font-size: 12px;
    color: var(--yellow);
    margin-top: 20px;
    line-height: 1.7;
  }
  .setup-warning code {
    background: rgba(251,191,36,0.15);
    border-radius: 4px;
    padding: 1px 5px;
    font-family: monospace;
    font-size: 11px;
  }
  .flex { display: flex; }
  .gap-2 { gap: 8px; }
  .gap-3 { gap: 12px; }
  .mt-1 { margin-top: 4px; }
  .mt-2 { margin-top: 8px; }
  .empty { text-align: center; padding: 40px 20px; color: var(--text3); font-size: 13px; }
  .empty-icon { font-size: 32px; margin-bottom: 8px; }
  .shifts-list { display: flex; flex-direction: column; gap: 8px; }
  .text-red { color: var(--red); }
  .received-check { color: var(--green); font-size: 16px; }
`;

// ─── App ─────────────────────────────────────────────────────────────────────

// Bump this when DEFAULT_HOSPITALS changes to force a re-merge on load
const HOSPITALS_VERSION = "v3";

function loadHospitals() {
  try {
    const version = localStorage.getItem("hospitals_version");
    const saved = JSON.parse(localStorage.getItem("hospitals") || "null");
    if (!saved || version !== HOSPITALS_VERSION) {
      if (saved) {
        // Merge: start from defaults, then overlay any hospitals the user customized
        const merged = DEFAULT_HOSPITALS.map(def => {
          const userVer = saved.find(s => s.id === def.id);
          return (userVer && userVer._customized) ? userVer : def;
        });
        // Also keep any hospitals the user added manually (not in defaults)
        saved.forEach(s => {
          if (!DEFAULT_HOSPITALS.find(d => d.id === s.id)) merged.push(s);
        });
        return merged;
      }
      return DEFAULT_HOSPITALS;
    }
    return saved;
  } catch { return DEFAULT_HOSPITALS; }
}

export default function App() {
  const [tab, setTab] = useState("dashboard");
  const [hospitals, setHospitals] = useState(loadHospitals);
  const [shifts, setShifts] = useState(() => {
    try { return JSON.parse(localStorage.getItem("shifts") || "[]"); }
    catch { return []; }
  });
  const [showAddShift, setShowAddShift] = useState(false);
  const [editShift, setEditShift] = useState(null);

  useEffect(() => {
    localStorage.setItem("hospitals", JSON.stringify(hospitals));
    localStorage.setItem("hospitals_version", HOSPITALS_VERSION);
  }, [hospitals]);
  useEffect(() => { localStorage.setItem("shifts", JSON.stringify(shifts)); }, [shifts]);

  const hospital = (id) => hospitals.find((h) => h.id === id);

  const markReceived = (shiftId) => {
    setShifts((s) => s.map((sh) => sh.id === shiftId ? { ...sh, received: !sh.received } : sh));
  };

  return (
    <>
      <style>{styles}</style>
      <div className="app">
        <div className="header">
          <div>
            <div className="header-title">🌱 MikaPlantões</div>
            <div className="header-sub">seu controle financeiro de plantões</div>
          </div>
        </div>

        <nav className="nav">
          {[
            { id: "dashboard", label: "📊 Dashboard" },
            { id: "hospitais", label: "🏥 Hospitais" },
            { id: "historico", label: "📋 Histórico" },
            { id: "exportar", label: "📤 Exportar" },
          ].map((t) => (
            <button key={t.id} className={`nav-btn ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>

        <div className="content">
          {tab === "dashboard" && <Dashboard shifts={shifts} hospitals={hospitals} onMark={markReceived} hospital={hospital} />}
          {tab === "hospitais" && <Hospitais hospitals={hospitals} setHospitals={setHospitals} />}
          {tab === "historico" && (
            <Historico shifts={shifts} setShifts={setShifts} hospital={hospital} onEdit={setEditShift} onMark={markReceived} />
          )}
          {tab === "exportar" && <Exportar shifts={shifts} hospitals={hospitals} />}
        </div>
      </div>

      {(tab === "dashboard" || tab === "historico") && (
        <button className="fab" onClick={() => setShowAddShift(true)}>
          <span>＋</span> Registrar Plantão
        </button>
      )}

      {(showAddShift || editShift) && (
        <ShiftModal
          hospitals={hospitals}
          editData={editShift}
          onClose={() => { setShowAddShift(false); setEditShift(null); }}
          onSave={(data) => {
            if (editShift) {
              setShifts((s) => s.map((sh) => sh.id === editShift.id ? { ...sh, ...data } : sh));
            } else {
              setShifts((s) => [...s, { ...data, id: Date.now().toString(), received: false }]);
            }
            setShowAddShift(false);
            setEditShift(null);
          }}
        />
      )}
    </>
  );
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

function Dashboard({ shifts, hospitals, onMark, hospital }) {
  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();

  const monthShifts = shifts.filter((sh) => {
    const d = new Date(sh.date + "T12:00:00");
    return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
  });

  const monthTotal = monthShifts.reduce((a, sh) => a + (sh.value || 0), 0);
  const pending = shifts.filter((sh) => !sh.received);
  const pendingTotal = pending.reduce((a, sh) => a + (sh.value || 0), 0);

  const overdueShifts = pending.filter((sh) => {
    const payDate = calcPaymentDate(sh.date, hospital(sh.hospitalId) || {});
    return payDateStr(payDate) < today();
  });

  // Monthly chart: last 6 months
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(thisYear, thisMonth - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() });
  }
  const chartData = months.map(({ year, month }) => {
    const total = shifts.filter((sh) => {
      const d = new Date(sh.date + "T12:00:00");
      return d.getFullYear() === year && d.getMonth() === month;
    }).reduce((a, sh) => a + (sh.value || 0), 0);
    const d = new Date(year, month, 1);
    return { label: d.toLocaleDateString("pt-BR", { month: "short" }), total };
  });
  const maxChart = Math.max(...chartData.map((d) => d.total), 1);

  return (
    <div>
      {/* Stats */}
      <div className="card-grid">
        <div className="stat-card">
          <div className="stat-label">Mês atual</div>
          <div className="stat-value">{fmtMoney(monthTotal)}</div>
          <div className="stat-sub">{monthShifts.length} {monthShifts.length !== 1 ? "plantões" : "plantão"} em {new Date().toLocaleDateString("pt-BR", { month: "long" })}</div>
        </div>
        <div className={`stat-card ${overdueShifts.length > 0 ? "red" : ""}`}>
          <div className={`stat-label ${overdueShifts.length > 0 ? "red" : ""}`}>
            {overdueShifts.length > 0 ? "Pagamento em atraso" : "Total a receber"}
          </div>
          <div className="stat-value">{fmtMoney(pendingTotal)}</div>
          <div className="stat-sub">{pending.length} {pending.length !== 1 ? "plantões" : "plantão"} pendente{pending.length !== 1 ? "s" : ""}</div>
        </div>
      </div>

      {/* Chart */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, color: "var(--text3)", textTransform: "uppercase", letterSpacing: "0.8px", marginBottom: 10 }}>Evolução mensal</div>
        <div className="chart-bars">
          {chartData.map((d, i) => (
            <div key={i} className="chart-bar-wrap">
              <div className="chart-bar-value">{d.total > 0 ? `${(d.total / 1000).toFixed(0)}k` : ""}</div>
              <div
                className="chart-bar"
                style={{ height: `${(d.total / maxChart) * 60}px` }}
                title={fmtMoney(d.total)}
              />
              <div className="chart-bar-label">{d.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Pending payments */}
      <div className="section-header">
        <div className="section-title">
          ⏳ Pagamentos pendentes
          {overdueShifts.length > 0 && (
            <span className="section-badge">· {overdueShifts.length} em atraso</span>
          )}
        </div>
      </div>

      {pending.length === 0 ? (
        <div className="empty"><div className="empty-icon">🎉</div>Todos os pagamentos confirmados!</div>
      ) : (
        <div className="shifts-list">
          {pending
            .map((sh) => {
              const h = hospitals.find((x) => x.id === sh.hospitalId);
              if (!h) return null;
              const payDate = calcPaymentDate(sh.date, h);
              const payIso = payDateStr(payDate);
              const overdue = isOverdue(payIso);
              const diffDays = Math.round((payDate - new Date()) / 86400000);
              let badge = null;
              if (overdue) badge = <span className="badge-overdue">ATRASADO</span>;
              else if (diffDays <= 7) badge = <span className="badge-soon">em {diffDays}d</span>;
              else badge = <span className="badge-ok">em {diffDays}d</span>;

              const gcTitle = `💰 Checar pagamento — ${h.name}`;
              const gcDesc = `Plantão: ${fmtDate(sh.date)}\nValor esperado: ${fmtMoney(sh.value)}\nHospital: ${h.name}`;
              const gcUrl = googleCalendarUrl(gcTitle, payIso, gcDesc);

              return (
                <div key={sh.id} className={`shift-item ${overdue ? "" : ""}`}>
                  <div className="shift-dot" style={{ background: h.color }} />
                  <div className="shift-info">
                    <div className="shift-name" style={{ color: h.color }}>{h.emoji} {h.name}</div>
                    <div className="shift-meta">
                      Plantão: {fmtDate(sh.date)} · {sh.hours ?? SHIFT_HOURS}h · Pag: {fmtDate(payIso)}
                      {sh.hours && sh.hours < SHIFT_HOURS && <span style={{ color: "var(--yellow)", marginLeft: 4 }}>⚡ parcial</span>}
                    </div>
                  </div>
                  {badge}
                  <div className="shift-value">{fmtMoney(sh.value)}</div>
                  <div className="shift-actions">
                    <a href={gcUrl} target="_blank" rel="noopener noreferrer" className="btn-icon calendar" title="Adicionar ao Google Calendar">🗓️</a>
                    <button className="btn-icon confirm" onClick={() => onMark(sh.id)} title="Marcar como recebido">✓</button>
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}

// ─── Hospitais ────────────────────────────────────────────────────────────────

const EMOJI_OPTIONS = ["🏥","🩷","💚","🔵","💛","🟣","🧡","❤️","🩵","🟢","🔴","⚪","🌸","💜","🩶"];
const COLOR_OPTIONS = [
  "#f472b6","#34d399","#60a5fa","#fbbf24","#a78bfa","#fb923c",
  "#f87171","#38bdf8","#4ade80","#e879f9","#facc15","#94a3b8",
];

function buildPayDayLabel(paymentType, payDay, payDayStart, payDayEnd) {
  if (paymentType === "next_month") return `Dia ${String(payDay).padStart(2,"0")} do mês seguinte`;
  if (paymentType === "same_month") return `Dia ${String(payDay).padStart(2,"0")} do mesmo mês`;
  if (paymentType === "45_after_month") return "45 dias após fim do mês";
  if (paymentType === "window_next_month") return `Entre dias ${payDayStart}–${payDayEnd} do mês seguinte`;
  return "";
}

function HospitalModal({ initial, onClose, onSave }) {
  const isNew = !initial;
  const [name, setName] = useState(initial?.name || "");
  const [emoji, setEmoji] = useState(initial?.emoji || "🏥");
  const [color, setColor] = useState(initial?.color || "#60a5fa");
  const [value, setValue] = useState(initial?.value ?? "");
  const [valueWeekend, setValueWeekend] = useState(initial?.valueWeekend ?? "");
  const [diffWeekend, setDiffWeekend] = useState(
    initial ? (initial.valueWeekend !== initial.value && initial.valueWeekend !== undefined) : false
  );
  const [paymentType, setPaymentType] = useState(initial?.paymentType || "next_month");
  const [payDay, setPayDay] = useState(initial?.payDay ?? 10);
  const [payDayStart, setPayDayStart] = useState(initial?.payDayStart ?? 20);
  const [payDayEnd, setPayDayEnd] = useState(initial?.payDayEnd ?? 24);

  const canSave = name.trim() && Number(value) > 0;

  function handleSave() {
    const wknd = diffWeekend && Number(valueWeekend) > 0 ? Number(valueWeekend) : Number(value);
    const label = buildPayDayLabel(paymentType, payDay, payDayStart, payDayEnd);
    onSave({
      id: initial?.id || `HOSP_${Date.now()}`,
      name: name.trim(),
      emoji,
      color,
      value: Number(value),
      valueWeekend: wknd,
      paymentType,
      payDay: Number(payDay),
      payDayStart: Number(payDayStart),
      payDayEnd: Number(payDayEnd),
      payDayLabel: label,
    });
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 460, maxHeight: "90vh", overflowY: "auto" }} onClick={e => e.stopPropagation()}>
        <div className="modal-title">{isNew ? "＋ Novo Hospital" : "✏️ Editar Hospital"}</div>

        {/* Emoji + cor */}
        <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <label className="form-label">Emoji</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {EMOJI_OPTIONS.map(e => (
                <button key={e} onClick={() => setEmoji(e)} style={{
                  width: 32, height: 32, border: `2px solid ${emoji === e ? color : "var(--border)"}`,
                  borderRadius: 8, background: emoji === e ? color + "22" : "var(--surface2)",
                  cursor: "pointer", fontSize: 16, transition: "all 0.15s"
                }}>{e}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="form-label">Cor</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 120 }}>
              {COLOR_OPTIONS.map(c => (
                <button key={c} onClick={() => setColor(c)} style={{
                  width: 24, height: 24, borderRadius: "50%", background: c, border: `2px solid ${color === c ? "#fff" : "transparent"}`,
                  cursor: "pointer", transition: "all 0.15s"
                }} />
              ))}
            </div>
          </div>
        </div>

        {/* Preview */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, padding: "10px 12px", background: "var(--surface2)", borderRadius: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: color + "22", border: `1.5px solid ${color}55`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>{emoji}</div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, color }}>{name || "Nome do hospital"}</div>
        </div>

        <div className="form-group">
          <label className="form-label">Nome</label>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Hospital das Clínicas" />
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">Valor semana (R$)</label>
            <input className="form-input" type="number" value={value} onChange={e => setValue(e.target.value)} placeholder="1500" />
          </div>
          <div style={{ display: "flex", alignItems: "center", paddingTop: 20 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text3)", cursor: "pointer", whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={diffWeekend} onChange={e => setDiffWeekend(e.target.checked)} />
              FDS diferente
            </label>
          </div>
        </div>

        {diffWeekend && (
          <div className="form-group">
            <label className="form-label">Valor fim de semana (R$)</label>
            <input className="form-input" type="number" value={valueWeekend} onChange={e => setValueWeekend(e.target.value)} placeholder="1700" />
          </div>
        )}

        <div className="form-group">
          <label className="form-label">Regra de pagamento</label>
          <select className="form-select" value={paymentType} onChange={e => setPaymentType(e.target.value)}>
            <option value="next_month">Dia fixo do mês seguinte</option>
            <option value="same_month">Dia fixo do mesmo mês</option>
            <option value="45_after_month">45 dias após fim do mês</option>
            <option value="window_next_month">Janela de dias (mês seguinte)</option>
          </select>
        </div>

        {(paymentType === "next_month" || paymentType === "same_month") && (
          <div className="form-group">
            <label className="form-label">Dia do pagamento</label>
            <input className="form-input" type="number" min={1} max={31} value={payDay} onChange={e => setPayDay(e.target.value)} />
          </div>
        )}

        {paymentType === "window_next_month" && (
          <div style={{ display: "flex", gap: 10 }}>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Dia inicial</label>
              <input className="form-input" type="number" min={1} max={31} value={payDayStart} onChange={e => setPayDayStart(e.target.value)} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Dia final</label>
              <input className="form-input" type="number" min={1} max={31} value={payDayEnd} onChange={e => setPayDayEnd(e.target.value)} />
            </div>
          </div>
        )}

        {/* Preview label */}
        <div style={{ fontSize: 12, color: "var(--accent)", marginBottom: 16, padding: "8px 12px", background: "rgba(124,106,247,0.08)", borderRadius: 8 }}>
          📅 {buildPayDayLabel(paymentType, payDay, payDayStart, payDayEnd)}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" style={{ flex: 1 }} disabled={!canSave} onClick={handleSave}>
            {isNew ? "Adicionar" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Hospitais({ hospitals, setHospitals }) {
  const [editingHospital, setEditingHospital] = useState(null); // null | "new" | hospital obj
  const [confirmDelete, setConfirmDelete] = useState(null);

  function saveHospital(data) {
    const marked = { ...data, _customized: true };
    if (editingHospital === "new") {
      setHospitals(prev => [...prev, marked]);
    } else {
      setHospitals(prev => prev.map(h => h.id === data.id ? marked : h));
    }
    setEditingHospital(null);
  }

  function deleteHospital(id) {
    setHospitals(prev => prev.filter(h => h.id !== id));
    setConfirmDelete(null);
  }

  return (
    <div>
      <div className="section-header" style={{ marginTop: 0 }}>
        <div className="section-title">🏥 Seus Hospitais</div>
        <button className="btn btn-primary" style={{ padding: "7px 14px", fontSize: 13 }} onClick={() => setEditingHospital("new")}>
          ＋ Novo
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {hospitals.map((h) => (
          <div key={h.id} className="hospital-card">
            <div className="hospital-dot" style={{ background: h.color + "22", border: `1.5px solid ${h.color}44` }}>
              {h.emoji}
            </div>
            <div className="hospital-info">
              <div className="hospital-name" style={{ color: h.color }}>{h.name}</div>
              <div className="hospital-detail">📅 {h.payDayLabel}</div>
            </div>
            <div className="hospital-values" style={{ marginRight: 8 }}>
              {h.value === h.valueWeekend || !h.valueWeekend ? (
                <div className="hospital-val">{fmtMoney(h.value)}</div>
              ) : (
                <>
                  <div className="hospital-val">{fmtMoney(h.value)}</div>
                  <div className="hospital-val-sub">FDS: {fmtMoney(h.valueWeekend)}</div>
                </>
              )}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn-icon edit" onClick={() => setEditingHospital(h)} title="Editar">✏️</button>
              <button className="btn-icon delete" onClick={() => setConfirmDelete(h)} title="Excluir">✕</button>
            </div>
          </div>
        ))}
      </div>

      {/* Confirm delete */}
      {confirmDelete && (
        <div className="modal-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="modal" style={{ maxWidth: 360 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">🗑️ Excluir hospital?</div>
            <p style={{ fontSize: 13, color: "var(--text2)", marginBottom: 20 }}>
              Tem certeza que quer excluir <strong style={{ color: confirmDelete.color }}>{confirmDelete.emoji} {confirmDelete.name}</strong>?
              Os plantões registrados não serão afetados.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmDelete(null)}>Cancelar</button>
              <button className="btn" style={{ flex: 1, background: "rgba(248,113,113,0.15)", color: "var(--red)", border: "1px solid rgba(248,113,113,0.3)" }}
                onClick={() => deleteHospital(confirmDelete.id)}>
                Excluir
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit / New modal */}
      {editingHospital && (
        <HospitalModal
          initial={editingHospital === "new" ? null : editingHospital}
          onClose={() => setEditingHospital(null)}
          onSave={saveHospital}
        />
      )}
    </div>
  );
}

// ─── Histórico ────────────────────────────────────────────────────────────────

function Historico({ shifts, setShifts, hospital, onEdit, onMark }) {
  const sorted = [...shifts].sort((a, b) => b.date.localeCompare(a.date));

  const byMonth = {};
  sorted.forEach((sh) => {
    const d = new Date(sh.date + "T12:00:00");
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!byMonth[key]) byMonth[key] = { year: d.getFullYear(), month: d.getMonth(), items: [] };
    byMonth[key].items.push(sh);
  });

  const deleteShift = (id) => {
    if (window.confirm("Excluir este plantão?")) {
      setShifts((s) => s.filter((sh) => sh.id !== id));
    }
  };

  if (sorted.length === 0) return (
    <div className="empty"><div className="empty-icon">📋</div>Nenhum plantões registrados ainda.</div>
  );

  return (
    <div>
      {Object.entries(byMonth).map(([key, { year, month, items }]) => {
        const total = items.reduce((a, sh) => a + (sh.value || 0), 0);
        return (
          <div key={key}>
            <div className="section-header">
              <div className="section-title">{monthLabel(year, month)}</div>
              <div style={{ fontSize: 13, color: "var(--green)", fontFamily: "'Syne', sans-serif", fontWeight: 700 }}>{fmtMoney(total)}</div>
            </div>
            <div className="shifts-list" style={{ marginBottom: 20 }}>
              {items.map((sh) => {
                const h = hospital(sh.hospitalId);
                if (!h) return null;
                const payDate = calcPaymentDate(sh.date, h);
                const payIso = payDateStr(payDate);
                const d = new Date(sh.date + "T12:00:00");
                const dayName = WEEKDAYS[d.getDay()];
                const gcTitle = `💰 Checar pagamento — ${h.name}`;
                const gcDesc = `Plantão: ${fmtDate(sh.date)}\nValor esperado: ${fmtMoney(sh.value)}\nHospital: ${h.name}`;
                const gcUrl = googleCalendarUrl(gcTitle, payIso, gcDesc);

                return (
                  <div key={sh.id} className={`shift-item ${sh.received ? "received" : ""}`}>
                    <div className="shift-dot" style={{ background: h.color }} />
                    <div className="shift-info">
                      <div className="shift-name" style={{ color: h.color }}>{h.emoji} {h.name}</div>
                      <div className="shift-meta">
                        {fmtDate(sh.date)} · {dayName} · {sh.hours ?? SHIFT_HOURS}h · pag {fmtDate(payIso)}
                        {sh.hours && sh.hours < SHIFT_HOURS && <span style={{ color: "var(--yellow)", marginLeft: 4 }}>⚡ parcial</span>}
                        {sh.received && <span style={{ color: "var(--green)", marginLeft: 6 }}>✓ recebido</span>}
                      </div>
                    </div>
                    <div className="shift-value">{fmtMoney(sh.value)}</div>
                    <div className="shift-actions">
                      {!sh.received && (
                        <a href={gcUrl} target="_blank" rel="noopener noreferrer" className="btn-icon calendar" title="Adicionar ao Google Calendar">🗓️</a>
                      )}
                      <button className="btn-icon edit" onClick={() => onEdit(sh)} title="Editar">✏️</button>
                      <button className="btn-icon confirm" onClick={() => onMark(sh.id)} title={sh.received ? "Desmarcar" : "Marcar recebido"}>
                        {sh.received ? "↩" : "✓"}
                      </button>
                      <button className="btn-icon delete" onClick={() => deleteShift(sh.id)} title="Excluir">✕</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Exportar ─────────────────────────────────────────────────────────────────

function Exportar({ shifts, hospitals }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [status, setStatus] = useState(null); // null | "loading" | { url } | { error }
  const [sheetsUrl, setSheetsUrl] = useState(null);
  const hasClientId = !!GOOGLE_CLIENT_ID;
  const isLoggedIn = !!getGoogleToken();
  const [loggedIn, setLoggedIn] = useState(isLoggedIn);

  const monthShifts = shifts.filter((sh) => {
    const d = new Date(sh.date + "T12:00:00");
    return d.getFullYear() === year && d.getMonth() === month;
  });
  const total = monthShifts.reduce((a, s) => a + (s.value || 0), 0);

  const months = Array.from({ length: 12 }, (_, i) => ({
    value: i,
    label: new Date(2024, i, 1).toLocaleDateString("pt-BR", { month: "long" }),
  }));
  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];

  async function handleExport() {
    setStatus("loading");
    setSheetsUrl(null);
    try {
      const url = await exportToSheets(shifts, hospitals, year, month);
      setSheetsUrl(url);
      setStatus("success");
      setLoggedIn(true);
    } catch (e) {
      if (e.message === "CLIENT_ID_MISSING") {
        setStatus("no_client_id");
      } else if (e.message?.includes("Popup")) {
        setStatus("popup_blocked");
      } else {
        setStatus({ error: e.message });
      }
    }
  }

  async function handleLogin() {
    try {
      await loginWithGoogle();
      setLoggedIn(true);
      setStatus(null);
    } catch (e) {
      setStatus({ error: e.message });
    }
  }

  function handleLogout() {
    clearGoogleToken();
    setLoggedIn(false);
    setStatus(null);
    setSheetsUrl(null);
  }

  // Preview table
  const hospital = (id) => hospitals.find((h) => h.id === id) || { name: id, emoji: "" };

  return (
    <div>
      <div className="section-header" style={{ marginTop: 0 }}>
        <div className="section-title">📤 Exportar para Google Sheets</div>
        {loggedIn && (
          <button className="btn btn-ghost" style={{ fontSize: 11, padding: "5px 10px" }} onClick={handleLogout}>
            Desconectar Google
          </button>
        )}
      </div>

      {!hasClientId && (
        <div className="setup-warning">
          <strong>⚙️ Configuração necessária (1 vez só)</strong><br />
          Para exportar para o Sheets, você precisa de um Client ID do Google:<br /><br />
          1. Acesse <strong>console.cloud.google.com</strong><br />
          2. Crie um projeto → Ative <strong>Google Sheets API</strong> e <strong>Google Drive API</strong><br />
          3. Crie credencial → <strong>OAuth 2.0 → Aplicativo da Web</strong><br />
          4. Em "Origens JS autorizadas" coloque a URL desse app<br />
          5. Copie o Client ID e cole na variável <code>GOOGLE_CLIENT_ID</code> no topo do código<br /><br />
          É gratuito e leva ~5 minutos. Quer um passo a passo detalhado?
        </div>
      )}

      {/* Seletor de mês */}
      <div className="card" style={{ marginTop: hasClientId ? 0 : 16 }}>
        <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.8px" }}>Selecione o período</div>
        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <select className="form-select" value={month} onChange={(e) => setMonth(Number(e.target.value))} style={{ flex: 2 }}>
            {months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <select className="form-select" value={year} onChange={(e) => setYear(Number(e.target.value))} style={{ flex: 1 }}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {/* Resumo */}
        <div style={{ background: "var(--surface2)", borderRadius: 8, padding: "10px 14px", marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "var(--text3)" }}>
              {monthShifts.length} {monthShifts.length !== 1 ? "plantões" : "plantão"} em {months[month].label} {year}
            </span>
            <span style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, color: "var(--green)", fontSize: 15 }}>
              {fmtMoney(total)}
            </span>
          </div>
        </div>

        {/* Preview mini-tabela */}
        {monthShifts.length > 0 && (
          <div style={{ overflowX: "auto", marginBottom: 14 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ background: "rgba(124,106,247,0.15)" }}>
                  {["Data", "Hospital", "Horas", "Valor", "Status"].map((h) => (
                    <th key={h} style={{ padding: "6px 10px", textAlign: "left", color: "var(--text3)", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...monthShifts].sort((a, b) => a.date.localeCompare(b.date)).map((sh) => {
                  const h = hospital(sh.hospitalId);
                  return (
                    <tr key={sh.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "7px 10px", color: "var(--text2)" }}>{fmtDate(sh.date)}</td>
                      <td style={{ padding: "7px 10px" }}><span style={{ color: h.color }}>{h.emoji} {h.name}</span></td>
                      <td style={{ padding: "7px 10px", color: "var(--text2)" }}>{sh.hours ?? SHIFT_HOURS}h</td>
                      <td style={{ padding: "7px 10px", fontFamily: "'Syne', sans-serif", fontWeight: 700, color: "var(--green)" }}>{fmtMoney(sh.value)}</td>
                      <td style={{ padding: "7px 10px" }}>
                        {sh.received
                          ? <span style={{ color: "var(--green)" }}>✓ Recebido</span>
                          : <span style={{ color: "var(--yellow)" }}>Pendente</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {monthShifts.length === 0 && (
          <div className="empty" style={{ padding: "20px 0" }}>
            <div className="empty-icon">🗓️</div>
            Nenhum plantão registrado neste mês.
          </div>
        )}

        {/* Botões de ação */}
        {hasClientId && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {!loggedIn ? (
              <button className="btn btn-sheets" style={{ flex: 1 }} onClick={handleLogin}>
                🔑 Conectar Google Account
              </button>
            ) : (
              <button
                className="btn btn-sheets"
                style={{ flex: 1 }}
                disabled={status === "loading" || monthShifts.length === 0}
                onClick={handleExport}
              >
                {status === "loading" ? "⏳ Exportando..." : "📊 Exportar para Google Sheets"}
              </button>
            )}
          </div>
        )}

        {/* Status messages */}
        {status === "success" && sheetsUrl && (
          <div className="export-status success">
            ✅ Aba atualizada com sucesso!{" "}
            <a href={sheetsUrl} target="_blank" rel="noopener noreferrer" className="export-link">
              Abrir planilha no Google Sheets →
            </a>
          </div>
        )}
        {status === "popup_blocked" && (
          <div className="export-status error">
            🚫 Popup bloqueado pelo browser. Permita popups para esse site e tente novamente.
          </div>
        )}
        {status?.error && (
          <div className="export-status error">❌ Erro: {status.error}</div>
        )}
      </div>

      {/* Info */}
      {hasClientId && (
        <div style={{ fontSize: 11, color: "var(--text3)", textAlign: "center", marginTop: 12, lineHeight: 1.7 }}>
          Todos os meses ficam numa planilha única <strong style={{color:"var(--text2)"}}>🩺 Plantões</strong> no seu Drive.<br />
          Cada mês vira uma aba separada. Exportar de novo atualiza a aba existente.
        </div>
      )}
    </div>
  );
}

// ─── Modal de Plantão ─────────────────────────────────────────────────────────

function ShiftModal({ hospitals, editData, onClose, onSave }) {
  const [date, setDate] = useState(editData?.date || today());
  const [hospitalId, setHospitalId] = useState(editData?.hospitalId || hospitals[0]?.id || "");
  const [hours, setHours] = useState(editData?.hours ?? SHIFT_HOURS);

  const h = hospitals.find((x) => x.id === hospitalId);
  const fullValue = h ? calcShiftValue(date, h) : 0;
  const value = calcValueByHours(fullValue, hours);
  const weekend = date ? isWeekend(date) : false;
  const payDate = h ? calcPaymentDate(date, h) : null;
  const isPartial = Number(hours) < SHIFT_HOURS;

  // quick-pick buttons
  const quickHours = [3, 6, 9, 12];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{editData ? "✏️ Editar Plantão" : "＋ Registrar Plantão"}</div>

        <div className="form-group">
          <label className="form-label">Data do Plantão</label>
          <input type="date" className="form-input" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>

        <div className="form-group">
          <label className="form-label">Hospital</label>
          <select className="form-select" value={hospitalId} onChange={(e) => setHospitalId(e.target.value)}>
            {hospitals.map((h) => (
              <option key={h.id} value={h.id}>{h.emoji} {h.name}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label className="form-label">Horas trabalhadas <span style={{color:"var(--text3)",fontWeight:400,textTransform:"none",letterSpacing:0}}>(plantão completo = 12h)</span></label>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {quickHours.map((q) => (
              <button
                key={q}
                className="btn"
                style={{
                  flex: 1,
                  padding: "7px 0",
                  fontSize: 13,
                  background: Number(hours) === q ? "rgba(124,106,247,0.25)" : "var(--surface2)",
                  color: Number(hours) === q ? "var(--accent)" : "var(--text3)",
                  border: `1px solid ${Number(hours) === q ? "rgba(124,106,247,0.5)" : "var(--border)"}`,
                  borderRadius: 8,
                }}
                onClick={() => setHours(q)}
              >
                {q}h
              </button>
            ))}
          </div>
          <input
            type="number"
            className="form-input"
            value={hours}
            min={0.5}
            max={12}
            step={0.5}
            onChange={(e) => setHours(e.target.value)}
            placeholder="ou digite as horas"
          />
        </div>

        {h && date && (
          <div className="preview-box">
            <div className="preview-row">
              <span className="preview-label">
                {weekend ? "☀️ Fim de semana" : "🌙 Dia de semana"}
                {isPartial && <span style={{color:"var(--yellow)",marginLeft:6,fontSize:10}}>⚡ {hours}h de {SHIFT_HOURS}h</span>}
              </span>
              <div style={{ textAlign: "right" }}>
                <span className="preview-value" style={{ color: "var(--green)" }}>{fmtMoney(value)}</span>
                {isPartial && (
                  <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2 }}>
                    plantão completo: {fmtMoney(fullValue)}
                  </div>
                )}
              </div>
            </div>
            {payDate && (
              <div className="preview-pay">
                💳 Pagamento previsto: {payDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })}
                {h.paymentType === "window_next_month" && ` (entre dias ${h.payDayStart}–${h.payDayEnd})`}
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancelar</button>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            disabled={!h || !date}
            onClick={() => onSave({ date, hospitalId, value, hours: Number(hours) })}
          >
            {editData ? "Salvar alterações" : "Registrar"}
          </button>
        </div>
      </div>
    </div>
  );
}
