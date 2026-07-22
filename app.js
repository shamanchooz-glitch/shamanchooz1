/* =========================================================================
   PROCHE — App de localisation et communication a consentement mutuel
   Backend : Firebase Realtime Database (REST). Hebergement : fichiers statiques
   (Cloudflare Pages/Workers).
   ========================================================================= */

// ------------------------------------------------------------------
// 1) CONFIGURATION — a completer avec VOTRE projet Firebase
// ------------------------------------------------------------------
// Creez un projet gratuit sur https://console.firebase.google.com
// -> Realtime Database -> Creer une base -> demarrer en mode "test"
// -> copiez l'URL (ex: https://mon-projet-xxxxx-default-rtdb.firebaseio.com)
const FB = "https://proche-app-default-rtdb.firebaseio.com";

// ------------------------------------------------------------------
// 2) ETAT GLOBAL
// ------------------------------------------------------------------
let currentUser = null;      // {id, pseudo, nom, tel, mdpHash, awayMode, awayMsg, createdAt}
let map = null;
let myMarker = null;
let contactMarkers = {};     // uid -> L.marker
let watchId = null;
let sharingLocation = false;
let currentChatUid = null;
let currentCallId = null;
let currentCallPeer = null;  // {uid, nom}
let currentCallType = null;  // 'audio' | 'video'
let pc = null;               // RTCPeerConnection
let localStream = null;
let remoteStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let candidateQueue = [];
let callPollTimer = null;
let mapPollTimer = null;
let contactsPollTimer = null;
let messagesPollTimer = null;
let incomingCallPollTimer = null;
let ringtoneTimer = null;
let seenMessageIds = {};
// STUN : suffit quand les deux telephones peuvent se joindre directement.
// TURN : sert de relais de secours quand le reseau bloque la connexion directe
// (Wi-Fi d'entreprise, certaines connexions mobiles restrictives...).
// Open Relay Project fournit un serveur TURN public et gratuit, largement
// utilise en production pour de petits/moyens projets.
const STUN = { iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
]};

// ------------------------------------------------------------------
// 3) UTILITAIRES FIREBASE (REST, sans SDK — coherent, leger, sans cle)
// ------------------------------------------------------------------
// Delai de securite : si Firebase ne repond pas assez vite (reseau lent,
// projet mal configure...), on n'attend pas indefiniment et on retombe sur
// une valeur par defaut au lieu de laisser l'interface bloquee sans retour.
function fbFetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 8000);
  return fetch(url, Object.assign({}, options, { signal: ctrl.signal })).finally(() => clearTimeout(timer));
}
function fbGet(path, cb) {
  fbFetchWithTimeout(FB + path + ".json")
    .then(r => r.json())
    .then(d => cb(d))
    .catch(() => cb(null));
}
function fbSet(path, data, cb) {
  fbFetchWithTimeout(FB + path + ".json", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  }).then(r => r.ok).then(ok => cb && cb(ok)).catch(() => cb && cb(false));
}
function fbPatch(path, data, cb) {
  fbFetchWithTimeout(FB + path + ".json", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data)
  }).then(r => r.ok).then(ok => cb && cb(ok)).catch(() => cb && cb(false));
}
function fbDelete(path, cb) {
  fbFetchWithTimeout(FB + path + ".json", { method: "DELETE" })
    .then(r => r.ok).then(ok => cb && cb(ok)).catch(() => cb && cb(false));
}
function genUid(prefix) {
  return (prefix||"") + Date.now() + "-" + Math.random().toString(36).slice(2, 9);
}
function hashPwd(pwd) {
  return btoa(unescape(encodeURIComponent(pwd)));
}
function nowTs() { return Date.now(); }
function convoId(a, b) { return [a, b].sort().join("__"); }
function initials(name) {
  if (!name) return "?";
  return name.trim().split(/\s+/).slice(0,2).map(w => w[0].toUpperCase()).join("");
}
function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function gv(id) { const el = document.getElementById(id); return el ? el.value.trim() : ""; }

// ------------------------------------------------------------------
// 4) AUTHENTIFICATION
// ------------------------------------------------------------------
function switchAuthTab(which) {
  document.getElementById("tab-login").classList.toggle("active", which === "login");
  document.getElementById("tab-register").classList.toggle("active", which === "register");
  document.getElementById("pane-login").classList.toggle("hidden", which !== "login");
  document.getElementById("pane-register").classList.toggle("hidden", which !== "register");
}

// ------------------------------------------------------------------
// INDICATIFS TELEPHONIQUES INTERNATIONAUX (pour que WhatsApp/SMS/Appel
// fonctionnent correctement quel que soit le pays de l'utilisateur)
// ------------------------------------------------------------------
const COUNTRY_CODES = [
  ["225","CI","Côte d'Ivoire"],["221","SN","Sénégal"],["223","ML","Mali"],["226","BF","Burkina Faso"],
  ["227","NE","Niger"],["228","TG","Togo"],["229","BJ","Bénin"],["224","GN","Guinée"],["220","GM","Gambie"],
  ["245","GW","Guinée-Bissau"],["238","CV","Cap-Vert"],["231","LR","Libéria"],["232","SL","Sierra Leone"],
  ["233","GH","Ghana"],["234","NG","Nigéria"],["237","CM","Cameroun"],["235","TD","Tchad"],
  ["236","CF","Centrafrique"],["240","GQ","Guinée équatoriale"],["241","GA","Gabon"],["242","CG","Congo-Brazzaville"],
  ["243","CD","RD Congo"],["244","AO","Angola"],["239","ST","Sao Tomé-et-Principe"],["212","MA","Maroc"],
  ["213","DZ","Algérie"],["216","TN","Tunisie"],["218","LY","Libye"],["20","EG","Égypte"],["249","SD","Soudan"],
  ["211","SS","Soudan du Sud"],["251","ET","Éthiopie"],["252","SO","Somalie"],["253","DJ","Djibouti"],
  ["254","KE","Kenya"],["255","TZ","Tanzanie"],["256","UG","Ouganda"],["257","BI","Burundi"],["250","RW","Rwanda"],
  ["258","MZ","Mozambique"],["260","ZM","Zambie"],["263","ZW","Zimbabwe"],["264","NA","Namibie"],
  ["267","BW","Botswana"],["266","LS","Lesotho"],["268","SZ","Eswatini"],["261","MG","Madagascar"],
  ["230","MU","Maurice"],["248","SC","Seychelles"],["27","ZA","Afrique du Sud"],
  ["33","FR","France"],["32","BE","Belgique"],["41","CH","Suisse"],["49","DE","Allemagne"],["44","GB","Royaume-Uni"],
  ["39","IT","Italie"],["34","ES","Espagne"],["351","PT","Portugal"],["31","NL","Pays-Bas"],["352","LU","Luxembourg"],
  ["353","IE","Irlande"],["30","GR","Grèce"],["45","DK","Danemark"],["46","SE","Suède"],["47","NO","Norvège"],
  ["358","FI","Finlande"],["48","PL","Pologne"],["420","CZ","Tchéquie"],["421","SK","Slovaquie"],["36","HU","Hongrie"],
  ["40","RO","Roumanie"],["359","BG","Bulgarie"],["385","HR","Croatie"],["386","SI","Slovénie"],["372","EE","Estonie"],
  ["371","LV","Lettonie"],["370","LT","Lituanie"],["354","IS","Islande"],["356","MT","Malte"],["357","CY","Chypre"],
  ["7","RU","Russie"],["380","UA","Ukraine"],["375","BY","Biélorussie"],["90","TR","Turquie"],
  ["1","US","États-Unis / Canada"],["52","MX","Mexique"],["55","BR","Brésil"],["54","AR","Argentine"],
  ["56","CL","Chili"],["57","CO","Colombie"],["51","PE","Pérou"],["58","VE","Venezuela"],["593","EC","Équateur"],
  ["591","BO","Bolivie"],["595","PY","Paraguay"],["598","UY","Uruguay"],["509","HT","Haïti"],
  ["1809","DO","Rép. Dominicaine"],["53","CU","Cuba"],
  ["86","CN","Chine"],["81","JP","Japon"],["82","KR","Corée du Sud"],["91","IN","Inde"],["92","PK","Pakistan"],
  ["880","BD","Bangladesh"],["94","LK","Sri Lanka"],["977","NP","Népal"],["66","TH","Thaïlande"],
  ["84","VN","Vietnam"],["63","PH","Philippines"],["60","MY","Malaisie"],["65","SG","Singapour"],
  ["62","ID","Indonésie"],["95","MM","Myanmar"],["855","KH","Cambodge"],["856","LA","Laos"],
  ["961","LB","Liban"],["962","JO","Jordanie"],["963","SY","Syrie"],["964","IQ","Irak"],["98","IR","Iran"],
  ["966","SA","Arabie Saoudite"],["971","AE","Émirats Arabes Unis"],["974","QA","Qatar"],["973","BH","Bahreïn"],
  ["965","KW","Koweït"],["968","OM","Oman"],["972","IL","Israël"],["970","PS","Palestine"],
  ["93","AF","Afghanistan"],["994","AZ","Azerbaïdjan"],["995","GE","Géorgie"],["374","AM","Arménie"],
  ["998","UZ","Ouzbékistan"],["996","KG","Kirghizistan"],["992","TJ","Tadjikistan"],["993","TM","Turkménistan"],
  ["61","AU","Australie"],["64","NZ","Nouvelle-Zélande"]
];
function populateCountrySelect(selId, defaultDial) {
  const sel = document.getElementById(selId);
  if (!sel || sel.options.length) return; // deja rempli
  const sorted = [...COUNTRY_CODES].sort((a, b) => a[2].localeCompare(b[2]));
  sorted.forEach(([dial, iso, name]) => {
    const opt = document.createElement("option");
    opt.value = dial; opt.textContent = "+" + dial + " " + name;
    if (dial === (defaultDial || "225")) opt.selected = true;
    sel.appendChild(opt);
  });
}
// Depuis leurs reformes de numerotation (2020-2021), la Cote d'Ivoire et le
// Benin ont integre le "0" initial dans le numero lui-meme : il ne s'agit
// plus d'un simple prefixe de reseau local, il doit rester meme en +225/+229.
const KEEP_LEADING_ZERO_COUNTRIES = ["225", "229"];
// Combine le code pays choisi + le numero local saisi en un numero international propre (+2250748935686)
function buildIntlPhone(ccSelId, telInputId) {
  const cc = gv(ccSelId);
  let local = (gv(telInputId) || "").replace(/[^\d]/g, "");
  if (local.startsWith("0") && !KEEP_LEADING_ZERO_COUNTRIES.includes(cc)) local = local.slice(1);
  if (!cc || !local) return "";
  return "+" + cc + local;
}
// Reconstitue {dial, local} a partir d'un numero deja enregistre, pour pre-remplir les champs a l'edition
function splitIntlPhone(full) {
  const digits = (full || "").replace(/[^\d]/g, "");
  if (!digits) return { dial: "225", local: "" };
  const sorted = [...COUNTRY_CODES].sort((a, b) => b[0].length - a[0].length);
  for (const [dial] of sorted) {
    if (digits.startsWith(dial)) return { dial, local: digits.slice(dial.length) };
  }
  return { dial: "225", local: digits.replace(/^0/, "") };
}
function fillPhoneFields(ccSelId, telInputId, fullNumber) {
  populateCountrySelect(ccSelId);
  const { dial, local } = splitIntlPhone(fullNumber);
  const sel = document.getElementById(ccSelId);
  if (sel) sel.value = dial;
  const inp = document.getElementById(telInputId);
  if (inp) inp.value = local;
}
// Filet de securite pour les anciens numeros deja enregistres sans indicatif
function normalizePhoneForLink(tel) {
  let digits = (tel || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  if ((tel || "").trim().startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  // Pas d'indicatif detecte : on suppose Cote d'Ivoire par defaut (le 0 initial est conserve, comme l'exige la numerotation ivoirienne)
  return "225" + digits;
}

function doRegister() {
  const nom = gv("rg-nom"), pseudo = gv("rg-pseudo"), tel = buildIntlPhone("rg-cc", "rg-tel"), mdp = gv("rg-mdp");
  if (!nom || !pseudo || !tel || !mdp) { showToast("Remplissez tous les champs"); return; }
  if (mdp.length < 6) { showToast("Mot de passe : 6 caracteres minimum"); return; }
  fbGet("/pr_users", (all) => {
    const users = all ? Object.values(all) : [];
    if (users.find(u => u && u.pseudo === pseudo)) { showToast("Ce pseudo est deja pris"); return; }
    const id = genUid("U-");
    const user = {
      id, nom, pseudo, tel,
      mdpHash: hashPwd(mdp),
      awayMode: false,
      awayMsg: "Je suis actuellement occupe(e) ou absent(e). Votre demande a bien ete recue et sera traitee sous 72h. Merci de votre comprehension.",
      createdAt: nowTs(),
      blocked: false,
      paymentStatus: "unpaid",
      bio: "", photo: null,
      bizName: "", bizDesc: "", bizHours: "", bizAddr: ""
    };
    fbSet("/pr_users/" + id, user, (ok) => {
      if (!ok) { showToast("Erreur reseau. Verifiez votre configuration Firebase."); return; }
      localStorage.setItem("pr_current", JSON.stringify(user));
      currentUser = user;
      showToast("Bienvenue " + nom + " 👋");
      enterApp();
    });
  });
}

function doLogin() {
  const pseudo = gv("lg-pseudo"), mdp = gv("lg-mdp");
  if (!pseudo || !mdp) { showToast("Remplissez tous les champs"); return; }
  const h = hashPwd(mdp);
  fbGet("/pr_users", (all) => {
    const users = all ? Object.values(all) : [];
    const found = users.find(u => u && (u.pseudo === pseudo || u.tel === pseudo) && u.mdpHash === h);
    if (!found) { showToast("Identifiants incorrects"); return; }
    if (found.blocked) { showToast("Ce compte a ete bloque par l'administrateur"); return; }
    currentUser = found;
    localStorage.setItem("pr_current", JSON.stringify(found));
    showToast("Bon retour, " + found.nom + " 👋");
    enterApp();
  });
}

function doLogout() {
  stopSharingLocation();
  clearInterval(mapPollTimer); clearInterval(contactsPollTimer);
  clearInterval(messagesPollTimer); clearInterval(incomingCallPollTimer);
  clearInterval(paywallPollTimer);
  localStorage.removeItem("pr_current");
  currentUser = null;
  document.getElementById("scr-app").classList.add("hidden");
  document.getElementById("bottomnav").classList.add("hidden");
  document.getElementById("prevnextbar").classList.add("hidden");
  document.getElementById("scr-paywall").classList.add("hidden");
  document.getElementById("scr-auth").classList.add("active");
  location.reload();
}

let paywallPollTimer = null;
function enterApp() {
  // Verifie toujours l'etat a jour (blocage/paiement) avant d'entrer
  fbGet("/pr_users/" + currentUser.id, fresh => {
    if (!fresh) return;
    currentUser = fresh;
    localStorage.setItem("pr_current", JSON.stringify(fresh));
    if (fresh.blocked) { showToast("Ce compte a ete bloque par l'administrateur"); doLogout(); return; }
    document.getElementById("scr-auth").classList.remove("active");
    if (fresh.paymentStatus !== "active") { showPaywall(); return; }
    showMainApp();
  });
}

let payZone = "ci";
let selectedOperator = "wave";
const OPERATOR_INFO = {
  wave: { nom: "Wave", numero: "+225 07 48 93 56 86" },
  mtn: { nom: "MTN Mobile Money", numero: "+225 05 74 53 36 36" },
  moov: { nom: "Moov Money", numero: "+225 01 73 77 39 39" },
  orange: { nom: "Orange Money", numero: "+225 07 49 97 09 18" }
};

function showPaywall() {
  document.getElementById("scr-app").classList.add("hidden");
  document.getElementById("bottomnav").classList.add("hidden");
  document.getElementById("prevnextbar").classList.add("hidden");
  document.getElementById("scr-paywall").classList.remove("hidden");
  setPayZone("ci");
  setOperator("wave");
  document.getElementById("pay-amount-ci").value = "5000";
  document.getElementById("pay-mynumber-ci").value = "";
  document.getElementById("pay-ref-ci").value = "";
  document.getElementById("pay-amount-intl").value = "";
  document.getElementById("pay-ref-intl").value = "";
  hideCiInstructions();
  updatePaySummary();
  updatePaywallStatusBox();
  clearInterval(paywallPollTimer);
  paywallPollTimer = setInterval(() => {
    fbGet("/pr_users/" + currentUser.id, fresh => {
      if (!fresh) return;
      if (fresh.blocked) { clearInterval(paywallPollTimer); showToast("Votre compte a ete bloque"); doLogout(); return; }
      if (fresh.paymentStatus === "active") {
        currentUser = fresh;
        localStorage.setItem("pr_current", JSON.stringify(fresh));
        clearInterval(paywallPollTimer);
        showToast("Votre compte a ete active ! 🎉");
        document.getElementById("scr-paywall").classList.add("hidden");
        showMainApp();
      }
    });
  }, 6000);
}

function updatePaywallStatusBox() {
  fbGet("/pr_payments/" + currentUser.id, payments => {
    const box = document.getElementById("pay-status-box");
    const list = payments ? Object.values(payments).sort((a,b) => b.ts - a.ts) : [];
    if (list.length && currentUser.paymentStatus !== "active") {
      box.classList.remove("hidden");
      box.textContent = "Votre demande a bien ete recue (reference : " + list[0].ref + "). L'administrateur va verifier et activer votre compte sous peu.";
    } else {
      box.classList.add("hidden");
    }
  });
}

function setPayZone(zone) {
  payZone = zone;
  document.getElementById("zone-ci").classList.toggle("active", zone === "ci");
  document.getElementById("zone-intl").classList.toggle("active", zone === "intl");
  document.getElementById("pay-pane-ci").classList.toggle("hidden", zone !== "ci");
  document.getElementById("pay-pane-intl").classList.toggle("hidden", zone !== "intl");
}

function setAmountCi(v) {
  document.getElementById("pay-amount-ci").value = v;
  updatePaySummary();
}
function setOperator(op) {
  selectedOperator = op;
  document.querySelectorAll(".operator-card").forEach(c => c.classList.toggle("selected", c.dataset.op === op));
  updatePaySummary();
}
function updatePaySummary() {
  const info = OPERATOR_INFO[selectedOperator];
  const amount = gv("pay-amount-ci") || "0";
  const num = gv("pay-mynumber-ci");
  document.getElementById("sum-operator").textContent = info.nom;
  document.getElementById("sum-number").textContent = num ? ("+225 " + num) : "--";
  document.getElementById("sum-amount").textContent = Number(amount).toLocaleString('fr-FR') + " F";
}

function showCiInstructions() {
  const amount = gv("pay-amount-ci");
  const num = gv("pay-mynumber-ci");
  if (!amount || Number(amount) < 100) { showToast("Indiquez un montant valide"); return; }
  if (!num) { showToast("Indiquez votre numero Mobile Money"); return; }
  const info = OPERATOR_INFO[selectedOperator];
  document.getElementById("ci-op-name").textContent = info.nom;
  document.getElementById("ci-op-amount").textContent = Number(amount).toLocaleString('fr-FR') + " F CFA";
  document.getElementById("ci-op-number").textContent = info.numero;
  document.getElementById("ci-instructions-block").classList.remove("hidden");
  document.getElementById("btn-show-ci-instructions").classList.add("hidden");
  document.getElementById("btn-back-ci").classList.remove("hidden");
}
function hideCiInstructions() {
  document.getElementById("ci-instructions-block").classList.add("hidden");
  document.getElementById("btn-show-ci-instructions").classList.remove("hidden");
  document.getElementById("btn-back-ci").classList.add("hidden");
}

// Soumission automatique quand la reference est collee (copier-coller) et fait plus de 6 caracteres
document.addEventListener("paste", (e) => {
  if (!e.target || !e.target.id) return;
  if (e.target.id === "pay-ref-ci") {
    setTimeout(() => { if (gv("pay-ref-ci").length > 6) submitPaymentCi(true); }, 30);
  }
  if (e.target.id === "pay-ref-intl") {
    setTimeout(() => { if (gv("pay-ref-intl").length > 6) submitPaymentIntl(true); }, 30);
  }
});

function submitPaymentCi(fromPaste) {
  const ref = gv("pay-ref-ci");
  if (!ref) { showToast("Indiquez la reference recue apres paiement"); return; }
  const info = OPERATOR_INFO[selectedOperator];
  const entry = {
    uid: currentUser.id, nom: currentUser.nom, tel: currentUser.tel,
    zone: "ci", method: info.nom, amount: gv("pay-amount-ci") + " F CFA",
    myNumber: "+225 " + gv("pay-mynumber-ci"),
    ref, ts: nowTs(), status: "pending", auto: !!fromPaste
  };
  finalizePayment(entry);
}
function submitPaymentIntl(fromPaste) {
  const ref = gv("pay-ref-intl");
  const amount = gv("pay-amount-intl");
  if (!amount) { showToast("Indiquez le montant envoye"); return; }
  if (!ref) { showToast("Indiquez la reference de transaction"); return; }
  const entry = {
    uid: currentUser.id, nom: currentUser.nom, tel: currentUser.tel,
    zone: "intl", method: document.getElementById("pay-method-intl").value,
    amount, ref, ts: nowTs(), status: "pending", auto: !!fromPaste
  };
  finalizePayment(entry);
}
function finalizePayment(entry) {
  const id = genUid("PAY-");
  fbSet("/pr_payments/" + entry.uid + "/" + id, entry, (ok) => {
    if (!ok) { showToast("Erreur d'envoi, verifiez votre connexion"); return; }
    showToast("Demande envoyee — l'administrateur va verifier et activer votre compte");
    updatePaywallStatusBox();
  });
}
function showMainApp() {
  document.getElementById("scr-app").classList.remove("hidden");
  document.getElementById("bottomnav").classList.remove("hidden");
  document.getElementById("prevnextbar").classList.remove("hidden");
  history.replaceState({ layer: "tab", screen: "map" }, "", "#map");
  document.getElementById("me-nom").textContent = currentUser.nom;
  document.getElementById("me-pseudo").textContent = "@" + currentUser.pseudo;
  renderMyAvatar();
  document.getElementById("set-nom").value = currentUser.nom;
  fillPhoneFields("set-cc", "set-tel", currentUser.tel);
  document.getElementById("set-email").value = currentUser.email || "";
  document.getElementById("set-bio").value = currentUser.bio || "";
  document.getElementById("set-biz-name").value = currentUser.bizName || "";
  document.getElementById("set-biz-desc").value = currentUser.bizDesc || "";
  document.getElementById("set-biz-hours").value = currentUser.bizHours || "";
  document.getElementById("set-biz-addr").value = currentUser.bizAddr || "";
  document.getElementById("away-msg-input").value = currentUser.awayMsg || "";
  document.getElementById("chk-away").checked = !!currentUser.awayMode;
  document.getElementById("me-created").textContent = new Date(currentUser.createdAt).toLocaleDateString('fr-FR');
  updateStatusPill();
  renderContactAdminButtons();
  initMap();
  refreshContacts();
  refreshMessagesList();
  refreshStatuses();
  startIncomingCallListener();
  loadAppLogo();
  fbPatch("/pr_presence/" + currentUser.id, { online: true, lastSeen: nowTs() });
  window.addEventListener("beforeunload", () => {
    fbPatch("/pr_presence/" + currentUser.id, { online: false, lastSeen: nowTs() });
  });
  setInterval(() => fbPatch("/pr_presence/" + currentUser.id, { online: true, lastSeen: nowTs() }), 25000);
}

function renderMyAvatar() {
  const el = document.getElementById("me-avatar");
  if (currentUser.photo) { el.style.backgroundImage = "url(" + currentUser.photo + ")"; el.style.backgroundSize = "cover"; el.style.backgroundPosition = "center"; el.textContent = ""; }
  else { el.style.backgroundImage = ""; el.textContent = initials(currentUser.nom); }
}

function updateStatusPill() {
  const pill = document.getElementById("my-status-pill");
  const txt = document.getElementById("my-status-txt");
  if (currentUser.awayMode) {
    pill.classList.add("away");
    txt.textContent = "Absent(e)";
  } else {
    pill.classList.remove("away");
    txt.textContent = "Disponible";
  }
}

function togglePwd(inputId, btn) {
  const inp = document.getElementById(inputId);
  const showing = inp.type === "text";
  inp.type = showing ? "password" : "text";
  btn.classList.toggle("on", !showing);
  btn.textContent = showing ? "👁️" : "🔒";
}

// ------------------------------------------------------------------
// 5) NAVIGATION
// ------------------------------------------------------------------
function goScreen(name, fromPop) {
  document.querySelectorAll("#scr-app .screen").forEach(s => s.classList.remove("active"));
  document.getElementById("scr-" + name).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.s === name));
  if (name === "map") {
    setTimeout(() => {
      if (mapProvider === "google" && gMap) google.maps.event.trigger(gMap, "resize");
      else if (map) map.invalidateSize();
    }, 150);
  }
  if (name === "contacts") refreshContacts();
  if (!fromPop) {
    history.replaceState({ layer: "tab", screen: name }, "", "#" + name);
  }
  currentTabName = name;
}
const TAB_ORDER = ["map", "contacts", "statuses", "calls", "messages", "settings"];
let currentTabName = "map";
function goPrevTab() {
  const i = TAB_ORDER.indexOf(currentTabName);
  const prev = TAB_ORDER[(i - 1 + TAB_ORDER.length) % TAB_ORDER.length];
  goScreen(prev);
}
function goNextTab() {
  const i = TAB_ORDER.indexOf(currentTabName);
  const next = TAB_ORDER[(i + 1) % TAB_ORDER.length];
  goScreen(next);
}
function goHomeFromAnywhere() {
  // Ferme toute fenetre ouverte par-dessus (chat/admin) puis revient a l'accueil
  history.go(-(history.state && history.state.layer === "overlay" ? 1 : 0));
  setTimeout(() => goScreen("map"), 60);
}
function confirmLogout() {
  if (confirm("Voulez-vous vraiment vous deconnecter ?")) doLogout();
}

// Un navigateur ne peut fermer par lui-meme qu'un onglet qu'IL a ouvert par script —
// c'est une regle de securite commune a toutes les apps web, pas une limite de cette app.
// On tente quand meme la fermeture, et on guide la personne si ca ne marche pas.
function attemptQuitApp() {
  window.close();
  setTimeout(() => {
    showToast("Utilisez le bouton Accueil ou Applications recentes de votre telephone pour fermer l'app");
  }, 300);
}

// ------------------------------------------------------------------
// NAVIGATION : le bouton retour du telephone reste DANS l'application
// (chat/admin sont des "calques" empiles sur l'onglet en cours, au lieu
// de fermer directement le navigateur/l'app installee)
// ------------------------------------------------------------------
window.addEventListener("popstate", (e) => {
  const chatOpen = document.getElementById("scr-chat").classList.contains("open");
  const adminOpen = !document.getElementById("scr-admin").classList.contains("hidden");
  const state = e.state || { layer: "tab", screen: "map" };
  if (state.layer !== "overlay") {
    if (chatOpen) doCloseChatUI();
    if (adminOpen) doCloseAdminUI();
    if (currentUser && !document.getElementById("scr-app").classList.contains("hidden")) {
      goScreen(state.screen || "map", true);
    }
  }
});

// ------------------------------------------------------------------
// 6) CARTE & LOCALISATION (consentement mutuel obligatoire)
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// ABSTRACTION CARTE : utilise Google Maps si une cle API est configuree
// dans l'espace admin, sinon retombe automatiquement sur OpenStreetMap
// (gratuit, sans cle, fonctionne partout des le depart).
// ------------------------------------------------------------------
let mapProvider = "leaflet";
let gMap = null;
let myMarkerStore = {};
let contactMarkerStore = {};
let mainLayers = null;
let adminLayers = null;

// Trois fonds de carte gratuits, sans cle API, utilisables partout dans le monde.
function makeBaseLayers() {
  return {
    default: L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap", maxZoom: 19
    }),
    satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri", maxZoom: 19
    }),
    terrain: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenTopoMap (CC-BY-SA)", maxZoom: 17
    })
  };
}
// Bascule le fond de carte affiche et met en surbrillance le bouton actif correspondant
function switchBaseLayer(mapObj, layers, which, btnGroupId) {
  if (!mapObj || !layers) return;
  Object.keys(layers).forEach(k => { if (mapObj.hasLayer(layers[k])) mapObj.removeLayer(layers[k]); });
  layers[which].addTo(mapObj);
  const grp = document.getElementById(btnGroupId);
  if (grp) grp.querySelectorAll(".map-layer-btn").forEach(b => b.classList.toggle("active", b.dataset.view === which));
}
function setMainMapView(which) { switchBaseLayer(map, mainLayers, which, "map-layer-switch"); }
function setAdminTrackMapView(which) { switchBaseLayer(adminTrackMap, adminLayers, which, "admin-map-layer-switch"); }

// ------------------------------------------------------------------
// PLEIN ECRAN POUR LES CARTES — reutilisable partout (utilisateur et admin)
// ------------------------------------------------------------------
function centerMainMap() {
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude, longitude } = pos.coords;
    if (mapProvider === "google" && gMap) gMap.setCenter({ lat: latitude, lng: longitude }), gMap.setZoom(16);
    else if (map) map.setView([latitude, longitude], 16);
  }, () => showToast("Impossible d'acceder a votre position — verifiez que la localisation est activee"), { enableHighAccuracy: true, timeout: 6000 });
}
function toggleMapFullscreen(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const btn = document.getElementById("fs-btn-" + containerId);
  const isFs = el.classList.toggle("map-fullscreen");
  document.body.classList.toggle("map-fs-lock", isFs);
  if (btn) btn.textContent = isFs ? "✕ Quitter le plein ecran" : "⛶ Plein ecran";
  setTimeout(() => {
    if (containerId === "map-container-main") {
      if (mapProvider === "google" && gMap) google.maps.event.trigger(gMap, "resize");
      else if (map) map.invalidateSize();
    } else if (containerId === "admin-self-map-container" && adminSelfMap) {
      adminSelfMap.invalidateSize();
    } else if (containerId === "admin-track-map-container" && adminTrackMap) {
      adminTrackMap.invalidateSize();
    }
  }, 60);
}

function loadGoogleMapsScript(key) {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.maps) return resolve();
    window.__onGMapsReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://maps.googleapis.com/maps/api/js?key=" + encodeURIComponent(key) + "&libraries=places&callback=__onGMapsReady";
    s.onerror = () => reject(new Error("Echec de chargement de Google Maps"));
    document.head.appendChild(s);
  });
}

async function initMap() {
  let gKey = null;
  try { gKey = await new Promise(res => fbGet("/pr_config/googleMapsKey", res)); } catch(e) {}
  if (gKey) {
    try {
      await loadGoogleMapsScript(gKey);
      mapProvider = "google";
      initGoogleMap();
      const sw = document.getElementById("map-layer-switch"); if (sw) sw.classList.add("hidden");
      mapPollTimer = setInterval(refreshContactsOnMap, 5000);
      refreshContactsOnMap();
      return;
    } catch (e) {
      showToast("Google Maps indisponible, utilisation de la carte gratuite");
      mapProvider = "leaflet";
    }
  } else {
    mapProvider = "leaflet";
  }
  const sw = document.getElementById("map-layer-switch"); if (sw) sw.classList.remove("hidden");
  initLeafletMap();
  mapPollTimer = setInterval(refreshContactsOnMap, 5000);
  refreshContactsOnMap();
}

function initGoogleMap() {
  gMap = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 6.827, lng: -5.289 }, zoom: 6,
    mapTypeControl: true,
    mapTypeControlOptions: {
      style: google.maps.MapTypeControlStyle.HORIZONTAL_BAR,
      mapTypeIds: ["roadmap", "satellite", "terrain"]
    },
    streetViewControl: true, fullscreenControl: true, zoomControl: true
  });
  navigator.geolocation && navigator.geolocation.getCurrentPosition(pos => {
    gMap.setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    gMap.setZoom(13);
  }, () => {}, { timeout: 5000 });
}

function initLeafletMap() {
  map = L.map("map", { zoomControl: true }).setView([6.827, -5.289], 6); // Cote d'Ivoire par defaut
  mainLayers = makeBaseLayers();
  mainLayers.default.addTo(map);
  navigator.geolocation && navigator.geolocation.getCurrentPosition(pos => {
    map.setView([pos.coords.latitude, pos.coords.longitude], 13);
  }, () => {}, { timeout: 5000 });
}

// Place ou deplace un marqueur, quel que soit le fournisseur de carte actif
function mapUpsertMarker(store, key, lat, lng, opts) {
  opts = opts || {};
  if (mapProvider === "google") {
    if (store[key]) { store[key].setPosition({ lat, lng }); }
    else {
      store[key] = new google.maps.Marker({
        position: { lat, lng }, map: gMap, title: opts.title || "",
        label: opts.initials ? { text: opts.initials, color: "#fff", fontWeight: "700", fontSize: "11px" } : undefined,
        icon: {
          path: google.maps.SymbolPath.CIRCLE, scale: 16,
          fillColor: opts.color || "#4A3AFF", fillOpacity: 1, strokeColor: "#fff", strokeWeight: 3
        }
      });
    }
  } else {
    if (store[key]) { store[key].setLatLng([lat, lng]); }
    else if (opts.isMe) {
      store[key] = L.circleMarker([lat, lng], { radius: 9, color: opts.color || "#4A3AFF", fillColor: opts.color || "#6A5AFF", fillOpacity: 0.9, weight: 3 }).addTo(map).bindPopup(opts.title || "");
    } else {
      store[key] = L.marker([lat, lng], {
        icon: L.divIcon({ className: "", html: '<div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#0EBFAE,#17D6C4);border:3px solid #fff;box-shadow:0 3px 10px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:0.75rem">' + (opts.initials || "") + '</div>', iconSize: [36, 36] })
      }).addTo(map).bindPopup(opts.title || "");
    }
  }
}
function mapRemoveMarker(store, key) {
  if (!store[key]) return;
  if (mapProvider === "google") store[key].setMap(null);
  else map.removeLayer(store[key]);
  delete store[key];
}
function mapCenterOn(lat, lng, zoom) {
  if (mapProvider === "google" && gMap) { gMap.setCenter({ lat, lng }); if (zoom) gMap.setZoom(zoom); }
  else if (map) { map.setView([lat, lng], zoom || map.getZoom()); }
}

function toggleShareLocation(on) {
  if (on) startSharingLocation(); else stopSharingLocation();
}

function startSharingLocation() {
  if (!navigator.geolocation) { showToast("Geolocalisation non disponible sur cet appareil"); document.getElementById("chk-share").checked = false; return; }
  navigator.geolocation.getCurrentPosition(() => {
    sharingLocation = true;
    document.getElementById("share-sub").textContent = "Active — vos proches acceptes vous voient en direct";
    watchId = navigator.geolocation.watchPosition(pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      fbSet("/pr_locations/" + currentUser.id, { lat: latitude, lng: longitude, acc: accuracy, ts: nowTs(), sharing: true });
      mapUpsertMarker(myMarkerStore, "me", latitude, longitude, { isMe: true, title: "Vous", color: "#4A3AFF" });
    }, err => {
      showToast("Impossible d'acceder a votre position : " + err.message);
      document.getElementById("chk-share").checked = false;
      sharingLocation = false;
    }, { enableHighAccuracy: true, maximumAge: 5000 });
  }, err => {
    showToast("Autorisation de localisation refusee");
    document.getElementById("chk-share").checked = false;
  });
}

function stopSharingLocation() {
  sharingLocation = false;
  if (watchId) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  mapRemoveMarker(myMarkerStore, "me");
  document.getElementById("share-sub") && (document.getElementById("share-sub").textContent = "Desactive — personne ne vous voit");
  if (currentUser) fbPatch("/pr_locations/" + currentUser.id, { sharing: false });
}

function refreshContactsOnMap() {
  if (!currentUser) return;
  getAcceptedContacts(list => {
    const legendEl = document.getElementById("contacts-on-map");
    if (!list.length) {
      legendEl.innerHTML = '<div class="empty-state" style="cursor:pointer" onclick="goToAddContact()"><div class="e-ic">🗺️</div>Ajoutez un proche et activez le partage mutuel pour le voir apparaitre ici.<div class="btn btn-primary" style="margin-top:12px;width:auto;display:inline-block;padding:10px 18px">+ Ajouter un proche</div></div>';
      return;
    }
    let pending = list.length;
    list.forEach(c => {
      fbGet("/pr_locations/" + c.uid, loc => {
        pending--;
        if (loc && loc.sharing && (nowTs() - loc.ts) < 5 * 60000) {
          mapUpsertMarker(contactMarkerStore, c.uid, loc.lat, loc.lng, { title: c.nom, initials: initials(c.nom), color: "#0EBFAE" });
        } else {
          mapRemoveMarker(contactMarkerStore, c.uid);
        }
        if (pending === 0) renderMapLegend(list);
      });
    });
  });
}

function renderMapLegend(list) {
  const wrap = document.getElementById("contacts-on-map");
  let html = '<div class="lbl" style="margin-top:2px">Vos proches</div>';
  list.forEach(c => {
    const live = !!contactMarkerStore[c.uid];
    html += `<div class="contact-pin-row" onclick="focusOnContact('${c.uid}')">
      <div class="avatar">${initials(c.nom)}</div>
      <div class="pin-info">
        <div class="pin-name">${c.nom}</div>
        <div class="pin-sub">${live ? '<span class="live-dot"></span>En direct' : 'Position non partagee'}</div>
      </div>
    </div>`;
  });
  wrap.innerHTML = html;
}

function focusOnContact(uid) {
  const m = contactMarkerStore[uid];
  if (!m) { showToast("Ce proche ne partage pas sa position pour le moment"); return; }
  const pos = mapProvider === "google" ? m.getPosition() : m.getLatLng();
  const lat = mapProvider === "google" ? pos.lat() : pos.lat;
  const lng = mapProvider === "google" ? pos.lng() : pos.lng;
  mapCenterOn(lat, lng, 15);
  goScreen("map");
}
// ------------------------------------------------------------------
// COMPOSER UN NOUVEL APPEL — choisir un proche accepte, puis audio ou video
// (reutilise le systeme d'appel WebRTC deja fonctionnel : startCall())
// ------------------------------------------------------------------
function openCallPicker() {
  if (!currentUser) return;
  fbGet("/pr_contacts/" + currentUser.id, data => {
    const uids = data ? Object.keys(data).filter(u => data[u].status === "accepted") : [];
    const overlay = document.createElement("div");
    overlay.className = "modal-bg open";
    overlay.style.zIndex = "9700";
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    if (!uids.length) {
      overlay.innerHTML = `<div class="modal-sheet" style="max-width:420px">
        <div class="modal-handle"></div>
        <button type="button" class="icon-btn" style="position:absolute;top:14px;right:14px" onclick="this.closest('.modal-bg').remove()">✕</button>
        <div class="card-h">📞 Choisir un proche</div>
        <p class="muted center" style="margin-top:14px">Vous n'avez pas encore de proche accepte. Ajoutez-en un dans l'onglet "Proches".</p>
      </div>`;
      document.body.appendChild(overlay);
      return;
    }
    fbGet("/pr_users", all => {
      let html = `<div class="modal-sheet" style="max-width:420px">
        <div class="modal-handle"></div>
        <button type="button" class="icon-btn" style="position:absolute;top:14px;right:14px" onclick="this.closest('.modal-bg').remove()">✕</button>
        <div class="card-h">📞 Choisir un proche a appeler</div>`;
      uids.forEach(uid => {
        const u = all && all[uid]; if (!u) return;
        html += `<div class="contact-row">
          <div class="avatar">${initials(u.nom)}</div>
          <div class="pin-info"><div class="pin-name">${u.nom}</div><div class="pin-sub">@${u.pseudo}</div></div>
          <div class="contact-acts">
            <button class="ic-btn ic-call" onclick="this.closest('.modal-bg').remove();startCall('${uid}','audio')">📞</button>
            <button class="ic-btn ic-video" onclick="this.closest('.modal-bg').remove();startCall('${uid}','video')">🎥</button>
          </div>
        </div>`;
      });
      html += `</div>`;
      overlay.innerHTML = html;
      document.body.appendChild(overlay);
    });
  });
}

function goToAddContact() {
  goScreen("contacts");
  setTimeout(() => {
    const input = document.getElementById("search-input");
    if (input) { input.focus(); input.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }, 80);
}

// ------------------------------------------------------------------
// 7) CONTACTS (recherche + consentement mutuel)
// ------------------------------------------------------------------
function onSearchInput() {
  const q = gv("search-input").toLowerCase();
  const resEl = document.getElementById("search-results");
  if (!q) { resEl.innerHTML = ""; return; }
  fbGet("/pr_users", (all) => {
    const users = all ? Object.values(all) : [];
    const matches = users.filter(u => u && u.id !== currentUser.id && (
      (u.pseudo || "").toLowerCase().includes(q) ||
      (u.nom || "").toLowerCase().includes(q) ||
      (u.tel || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q)
    )).slice(0, 8);
    if (!matches.length) { resEl.innerHTML = '<p class="muted center" style="padding:10px">Aucun resultat</p>'; return; }
    resEl.innerHTML = matches.map(u => `
      <div class="contact-row">
        <div class="avatar">${initials(u.nom)}</div>
        <div class="pin-info"><div class="pin-name">${u.nom}</div><div class="pin-sub">@${u.pseudo}</div></div>
        <button class="btn-sm btn-primary" style="background:var(--indigo);color:#fff" onclick="sendContactRequest('${u.id}','${u.nom.replace(/'/g,"")}')">+ Ajouter</button>
      </div>`).join("");
  });
}

function sendContactRequest(uid, nom) {
  fbSet("/pr_contacts/" + currentUser.id + "/" + uid, { status: "pending", requestedBy: currentUser.id, ts: nowTs() }, ok1 => {
    if (!ok1) { showToast("Echec de l'envoi — verifiez votre connexion et reessayez"); return; }
    fbSet("/pr_contacts/" + uid + "/" + currentUser.id, { status: "pending", requestedBy: currentUser.id, ts: nowTs() }, ok2 => {
      if (!ok2) { showToast("Echec de l'envoi — verifiez votre connexion et reessayez"); return; }
      showToast("Demande envoyee a " + nom);
      document.getElementById("search-input").value = "";
      document.getElementById("search-results").innerHTML = "";
      refreshContacts();
    });
  });
}

function acceptContactRequest(uid) {
  fbPatch("/pr_contacts/" + currentUser.id + "/" + uid, { status: "accepted" }, ok1 => {
    if (!ok1) { showToast("Echec — verifiez votre connexion et reessayez"); return; }
    fbPatch("/pr_contacts/" + uid + "/" + currentUser.id, { status: "accepted" }, ok2 => {
      if (!ok2) { showToast("Echec — verifiez votre connexion et reessayez"); return; }
      showToast("Demande acceptee");
      refreshContacts();
    });
  });
}
function declineContactRequest(uid) {
  fbDelete("/pr_contacts/" + currentUser.id + "/" + uid);
  fbDelete("/pr_contacts/" + uid + "/" + currentUser.id);
  refreshContacts();
}
function removeContact(uid) {
  if (!confirm("Retirer ce proche ? Le partage de position sera coupe.")) return;
  fbDelete("/pr_contacts/" + currentUser.id + "/" + uid);
  fbDelete("/pr_contacts/" + uid + "/" + currentUser.id);
  refreshContacts();
}

let contactTab = "accepted";
function setContactTab(t, el) {
  contactTab = t;
  document.querySelectorAll(".tab-chip").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  refreshContacts();
}

function getAcceptedContacts(cb) {
  if (!currentUser) return cb([]);
  fbGet("/pr_contacts/" + currentUser.id, (data) => {
    if (!data) return cb([]);
    const uids = Object.keys(data).filter(uid => data[uid].status === "accepted");
    if (!uids.length) return cb([]);
    fbGet("/pr_users", (all) => {
      const list = uids.map(uid => all && all[uid] ? { uid, nom: all[uid].nom, pseudo: all[uid].pseudo } : null).filter(Boolean);
      cb(list);
    });
  });
}

function refreshContacts() {
  if (!currentUser) return;
  if (contactTab === "external") { renderExternalContacts(); return; }
  fbGet("/pr_contacts/" + currentUser.id, (data) => {
    const listEl = document.getElementById("contacts-list");
    if (!data) { listEl.innerHTML = '<div class="empty-state"><div class="e-ic">👥</div>Recherchez une personne ci-dessus pour l\'ajouter.</div>'; document.getElementById("badge-contacts").classList.add("hidden"); return; }
    let uids;
    if (contactTab === "accepted") uids = Object.keys(data).filter(u => data[u].status === "accepted");
    else if (contactTab === "pending-in") uids = Object.keys(data).filter(u => data[u].status === "pending" && data[u].requestedBy !== currentUser.id);
    else uids = Object.keys(data).filter(u => data[u].status === "pending" && data[u].requestedBy === currentUser.id);

    const pendingInCount = Object.keys(data).filter(u => data[u].status === "pending" && data[u].requestedBy !== currentUser.id).length;
    const badge = document.getElementById("badge-contacts");
    if (pendingInCount > 0) { badge.textContent = pendingInCount; badge.classList.remove("hidden"); } else badge.classList.add("hidden");

    if (!uids.length) { listEl.innerHTML = '<div class="empty-state"><div class="e-ic">👥</div>Rien ici pour le moment.</div>'; return; }
    fbGet("/pr_users", (all) => {
      if (contactTab === "accepted") {
        const validUids = uids.filter(uid => all && all[uid]);
        if (!validUids.length) { listEl.innerHTML = '<div class="empty-state"><div class="e-ic">👥</div>Rien ici pour le moment.</div>'; return; }
        let pending = validUids.length;
        const rows = {};
        validUids.forEach(uid => {
          const u = all[uid];
          fbGet("/pr_locations/" + uid, loc => {
            pending--;
            const live = !!(loc && loc.sharing && (nowTs() - loc.ts) < 5 * 60000);
            rows[uid] = { u, live };
            if (pending === 0) {
              let html = "";
              validUids.forEach(id => {
                const { u, live } = rows[id];
                html += `<div class="contact-row">
                  <div class="avatar" onclick="openProfileModal('${id}')">${initials(u.nom)}</div>
                  <div class="pin-info" onclick="openProfileModal('${id}')"><div class="pin-name">${u.nom}</div><div class="pin-sub">@${u.pseudo}${live ? ' · 🟢 en direct' : ' · position non partagee'}</div></div>
                  <div class="contact-acts">
                    ${!live ? `<button class="ic-btn" title="Demander l'activation du partage" onclick="askActivateSharing('${(u.nom||'').replace(/'/g,"")}','${u.tel||''}','${u.email||''}')">📨</button>` : ''}
                    <button class="ic-btn ic-call" onclick="startCall('${id}','audio')">📞</button>
                    <button class="ic-btn ic-video" onclick="startCall('${id}','video')">🎥</button>
                    <button class="ic-btn ic-msg" onclick="openChat('${id}','${(u.nom||'').replace(/'/g,"")}')">💬</button>
                  </div>
                </div>`;
              });
              listEl.innerHTML = html;
            }
          });
        });
        return;
      }
      let html = "";
      uids.forEach(uid => {
        const u = all && all[uid]; if (!u) return;
        if (contactTab === "pending-in") {
          html += `<div class="contact-row">
            <div class="avatar">${initials(u.nom)}</div>
            <div class="pin-info"><div class="pin-name">${u.nom}</div><div class="pin-sub">Souhaite vous ajouter</div></div>
            <div class="contact-acts">
              <button class="ic-btn ic-call" style="background:var(--teal-pale)" onclick="acceptContactRequest('${uid}')">✓</button>
              <button class="ic-btn" style="background:var(--rose-pale);color:#B3184A" onclick="declineContactRequest('${uid}')">✕</button>
            </div>
          </div>`;
        } else {
          html += `<div class="contact-row">
            <div class="avatar">${initials(u.nom)}</div>
            <div class="pin-info"><div class="pin-name">${u.nom}</div><div class="pin-sub">En attente de reponse</div></div>
            <button class="btn-sm" style="background:var(--indigo);color:#fff" onclick="askActivateSharing('${(u.nom||'').replace(/'/g,"")}','${u.tel||''}','${u.email||''}')">📨 Relancer</button>
            <button class="btn-sm btn-ghost" onclick="removeContact('${uid}')">Annuler</button>
          </div>`;
        }
      });
      listEl.innerHTML = html;
    });
  });
}

function openProfileModal(uid) {
  fbGet("/pr_users/" + uid, u => {
    if (!u) return;
    document.getElementById("profile-modal-body").innerHTML = `
      <div class="center" style="margin-bottom:16px">
        <div class="avatar" style="width:70px;height:70px;font-size:1.5rem;margin:0 auto 10px">${initials(u.nom)}</div>
        <div style="font-weight:800;font-size:1.1rem">${u.nom}</div>
        <div class="muted">@${u.pseudo} · ${u.tel||''}</div>
      </div>
      <div class="row2">
        <button class="btn btn-teal" onclick="closeProfileModal();startCall('${uid}','audio')">📞 Appeler</button>
        <button class="btn btn-primary" onclick="closeProfileModal();startCall('${uid}','video')">🎥 Video</button>
      </div>
      <button class="btn btn-ghost" style="margin-top:10px" onclick="closeProfileModal();openChat('${uid}','${u.nom.replace(/'/g,"")}')">💬 Message</button>
      <button class="btn btn-ghost" style="margin-top:10px" onclick="focusOnContact('${uid}');closeProfileModal()">🗺️ Voir sur la carte</button>
      <button class="btn btn-danger" style="margin-top:14px" onclick="removeContact('${uid}');closeProfileModal()">Retirer ce proche</button>
    `;
    document.getElementById("modal-profile").classList.add("open");
  });
}
function closeProfileModal() { document.getElementById("modal-profile").classList.remove("open"); }

// ------------------------------------------------------------------
// 8) MESSAGERIE INTERNE
// ------------------------------------------------------------------
function refreshMessagesList() {
  if (!currentUser) return;
  getAcceptedContacts(list => {
    const wrap = document.getElementById("convo-list");
    if (!list.length) { wrap.innerHTML = '<div class="empty-state" style="cursor:pointer" onclick="goToAddContact()"><div class="e-ic">💬</div>Ajoutez un proche pour commencer a discuter.<div class="btn btn-primary" style="margin-top:12px;width:auto;display:inline-block;padding:10px 18px">+ Ajouter un proche</div></div>'; return; }
    let unreadTotal = 0;
    let html = "";
    let pending = list.length;
    list.forEach(c => {
      fbGet("/pr_conversations/" + convoId(currentUser.id, c.uid) + "/messages", msgs => {
        pending--;
        let last = null, unread = 0;
        if (msgs) {
          const arr = Object.values(msgs).sort((a,b) => a.ts - b.ts);
          last = arr[arr.length - 1];
          unread = arr.filter(m => m.from !== currentUser.id && !m.read).length;
        }
        unreadTotal += unread;
        html += `<div class="convo-row" onclick="openChat('${c.uid}','${c.nom.replace(/'/g,"")}')">
          <div class="avatar">${initials(c.nom)}</div>
          <div class="pin-info">
            <div class="pin-name">${c.nom}</div>
            <div class="convo-last">${last ? (last.auto ? '🤖 ' : '') + escapeHtml(last.text) : 'Dites bonjour 👋'}</div>
          </div>
          ${last ? `<div class="muted" style="font-size:0.68rem">${fmtTime(last.ts)}</div>` : ''}
          ${unread ? `<span class="nav-badge" style="position:static">${unread}</span>` : ''}
        </div>`;
        if (pending === 0) {
          wrap.innerHTML = html;
          const badge = document.getElementById("badge-messages");
          if (unreadTotal > 0) { badge.textContent = unreadTotal; badge.classList.remove("hidden"); } else badge.classList.add("hidden");
        }
      });
    });
  });
}
function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }

function openChat(uid, nom) {
  currentChatUid = uid;
  document.getElementById("chat-avatar").textContent = initials(nom);
  document.getElementById("chat-name").textContent = nom;
  document.getElementById("chat-sub").textContent = "";
  document.getElementById("scr-chat").classList.add("open");
  loadChatMessages();
  messagesPollTimer && clearInterval(messagesPollTimer);
  messagesPollTimer = setInterval(loadChatMessages, 2500);
  history.pushState({ layer: "overlay", screen: "chat" }, "", "#chat");
}
function closeChat() {
  // Declenche le retour dans l'historique ; la fermeture reelle se fait
  // dans doCloseChatUI(), appelee automatiquement par le gestionnaire popstate.
  if (history.state && history.state.layer === "overlay") history.back();
  else doCloseChatUI();
}
function doCloseChatUI() {
  document.getElementById("scr-chat").classList.remove("open");
  currentChatUid = null;
  clearInterval(messagesPollTimer);
  refreshMessagesList();
}

function loadChatMessages() {
  if (!currentChatUid) return;
  const cid = convoId(currentUser.id, currentChatUid);
  fbGet("/pr_conversations/" + cid + "/messages", msgs => {
    const body = document.getElementById("chat-body");
    if (!msgs) { body.innerHTML = '<p class="muted center" style="margin-top:30px">Aucun message pour le moment</p>'; return; }
    const arr = Object.entries(msgs).sort((a,b) => a[1].ts - b[1].ts);
    let html = "";
    arr.forEach(([mid, m]) => {
      const mine = m.from === currentUser.id;
      html += `<div class="bubble ${mine ? 'me' : (m.auto ? 'auto' : 'them')}">${escapeHtml(m.text)}<div class="bubble-time">${m.auto ? '🤖 auto · ' : ''}${fmtTime(m.ts)}</div></div>`;
      if (!mine && !m.read) fbPatch("/pr_conversations/" + cid + "/messages/" + mid, { read: true });
    });
    body.innerHTML = html;
    body.scrollTop = body.scrollHeight;
  });
}

function sendChatMessage(auto, presetText, toUidOverride) {
  const toUid = toUidOverride || currentChatUid;
  const text = auto ? presetText : gv("chat-input");
  if (!text || !toUid) return;
  const cid = convoId(currentUser.id, toUid);
  const mid = genUid("M-");
  fbSet("/pr_conversations/" + cid + "/messages/" + mid, {
    from: currentUser.id, to: toUid, text, ts: nowTs(), read: false, auto: !!auto
  }, () => {
    if (!auto) { document.getElementById("chat-input").value = ""; loadChatMessages(); }
  });
}

// ------------------------------------------------------------------
// 9) APPELS (WebRTC + signalisation via Firebase)
// ------------------------------------------------------------------
function startIncomingCallListener() {
  incomingCallPollTimer = setInterval(() => {
    if (currentCallId) return; // deja en communication
    fbGet("/pr_calls", (all) => {
      if (!all) return;
      const incoming = Object.entries(all).find(([id, c]) => c.to === currentUser.id && c.status === "ringing");
      if (incoming) handleIncomingCall(incoming[0], incoming[1]);
    });
  }, 2000);
}

function handleIncomingCall(callId, call) {
  fbGet("/pr_users/" + call.from, caller => {
    if (!caller) return;
    if (currentUser.awayMode) {
      // Assistant : decline automatiquement apres un court delai et informe le correspondant
      setTimeout(() => {
        fbGet("/pr_calls/" + callId, c => {
          if (c && c.status === "ringing") {
            fbPatch("/pr_calls/" + callId, { status: "declined-auto" });
            sendChatMessage(true, currentUser.awayMsg, call.from);
            logCallEnd(callId, call, "missed");
          }
        });
      }, 6000);
      return;
    }
    currentCallId = callId;
    currentCallPeer = { uid: call.from, nom: caller.nom };
    currentCallType = call.type;
    document.getElementById("inc-avatar").textContent = initials(caller.nom);
    document.getElementById("inc-name").textContent = caller.nom;
    document.getElementById("inc-type").textContent = (call.type === "video" ? "Appel video entrant..." : "Appel entrant...");
    document.getElementById("modal-incoming").classList.add("open");
    playRingtone();
  });
}

function startCall(uid, type) {
  fbGet("/pr_users/" + uid, target => {
    if (!target) return;
    const callId = genUid("C-");
    currentCallId = callId;
    currentCallPeer = { uid, nom: target.nom };
    currentCallType = type;
    fbSet("/pr_calls/" + callId, { from: currentUser.id, to: uid, type, status: "ringing", startedAt: nowTs() });
    openCallUI(true);
    setupPeerConnection(true);
    // Si pas de reponse en 35s, on annule
    setTimeout(() => {
      fbGet("/pr_calls/" + callId, c => {
        if (c && c.status === "ringing") { fbPatch("/pr_calls/" + callId, { status: "missed" }); endCall(); }
      });
    }, 35000);
  });
}

function acceptCall() {
  stopRingtone();
  document.getElementById("modal-incoming").classList.remove("open");
  fbPatch("/pr_calls/" + currentCallId, { status: "accepted" });
  openCallUI(false);
  setupPeerConnection(false);
}
function declineCall() {
  stopRingtone();
  document.getElementById("modal-incoming").classList.remove("open");
  fbPatch("/pr_calls/" + currentCallId, { status: "declined" });
  logCallEnd(currentCallId, { from: currentCallPeer.uid, to: currentUser.id, type: currentCallType }, "missed");
  resetCallState();
}

function openCallUI(isCaller) {
  document.getElementById("call-avatar").textContent = initials(currentCallPeer.nom);
  document.getElementById("call-name").textContent = currentCallPeer.nom;
  document.getElementById("call-status").textContent = isCaller ? "Appel en cours..." : "Connexion...";
  document.getElementById("modal-call").classList.add("open");
  const isVideo = currentCallType === "video";
  document.getElementById("video-stage").classList.toggle("hidden", !isVideo);
  document.getElementById("audio-only-info").classList.toggle("hidden", isVideo);
  document.getElementById("btn-cam").classList.toggle("hidden", !isVideo);
}

async function setupPeerConnection(isCaller) {
  pc = new RTCPeerConnection(STUN);
  remoteStream = new MediaStream();
  document.getElementById("remote-video").srcObject = remoteStream;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: currentCallType === "video" ? { facingMode: "user" } : false
    });
  } catch (e) {
    showToast("Impossible d'acceder au micro/camera : " + e.message);
    endCall();
    return;
  }
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  if (currentCallType === "video") {
    const lv = document.getElementById("local-video");
    lv.srcObject = localStream;
    lv.classList.remove("hidden");
  }

  pc.ontrack = (e) => { e.streams[0].getTracks().forEach(t => remoteStream.addTrack(t)); };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") document.getElementById("call-status").textContent = "En communication";
    if (["disconnected","failed","closed"].includes(pc.connectionState)) endCall();
  };

  const path = "/pr_calls/" + currentCallId;
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const field = isCaller ? "candidatesFrom" : "candidatesTo";
      fbGet(path + "/" + field, list => {
        const arr = list ? Object.values(list) : [];
        arr.push(e.candidate.toJSON());
        fbSet(path + "/" + field, arr);
      });
    }
  };

  if (isCaller) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    fbPatch(path, { offer: JSON.stringify(offer) });
    pollForAnswer(path);
  } else {
    fbGet(path, async (call) => {
      if (!call || !call.offer) return;
      await pc.setRemoteDescription(JSON.parse(call.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      fbPatch(path, { answer: JSON.stringify(answer) });
      pollForRemoteCandidates(path, "candidatesFrom");
    });
  }
}

function pollForAnswer(path) {
  callPollTimer = setInterval(() => {
    fbGet(path, async (call) => {
      if (!call) return;
      if (call.status === "declined" || call.status === "declined-auto") { showToast(currentCallPeer.nom + " n'est pas disponible"); endCall(); return; }
      if (call.answer && pc && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription(JSON.parse(call.answer));
        pollForRemoteCandidates(path, "candidatesTo");
        document.getElementById("call-status").textContent = "En communication";
      }
    });
  }, 1200);
}

let appliedCandidates = {};
function pollForRemoteCandidates(path, field) {
  appliedCandidates[field] = appliedCandidates[field] || 0;
  clearInterval(pollForRemoteCandidates._t && pollForRemoteCandidates._t[field]);
  pollForRemoteCandidates._t = pollForRemoteCandidates._t || {};
  pollForRemoteCandidates._t[field] = setInterval(() => {
    if (!pc) return;
    fbGet(path + "/" + field, list => {
      if (!list) return;
      const arr = Object.values(list);
      for (let i = appliedCandidates[field]; i < arr.length; i++) {
        pc.addIceCandidate(new RTCIceCandidate(arr[i])).catch(()=>{});
      }
      appliedCandidates[field] = arr.length;
    });
  }, 1500);
}

function toggleMute() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  document.getElementById("btn-mute").classList.toggle("on", !track.enabled);
  document.getElementById("btn-mute").textContent = track.enabled ? "🎤" : "🔇";
}
function toggleCam() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  document.getElementById("btn-cam").classList.toggle("on", !track.enabled);
}
function toggleSpeaker() {
  const btn = document.getElementById("btn-speaker");
  btn.classList.toggle("on");
  showToast(btn.classList.contains("on") ? "Haut-parleur active" : "Haut-parleur desactive");
}

function toggleRecording() {
  if (isRecording) { stopRecording(); return; }
  startRecording();
}
function startRecording() {
  try {
    const mixed = new MediaStream();
    if (localStream) localStream.getAudioTracks().forEach(t => mixed.addTrack(t));
    if (remoteStream) remoteStream.getAudioTracks().forEach(t => mixed.addTrack(t));
    if (!mixed.getTracks().length) { showToast("Rien a enregistrer pour le moment"); return; }
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(mixed);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = saveRecording;
    mediaRecorder.start();
    isRecording = true;
    document.getElementById("btn-rec").classList.add("on");
    document.getElementById("rec-badge").classList.remove("hidden");
    showToast("Enregistrement demarre — pensez a en informer votre correspondant");
  } catch (e) {
    showToast("Enregistrement non pris en charge par ce navigateur");
  }
}
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  isRecording = false;
  document.getElementById("btn-rec").classList.remove("on");
  document.getElementById("rec-badge").classList.add("hidden");
}
function saveRecording() {
  if (!recordedChunks.length) return;
  const blob = new Blob(recordedChunks, { type: "audio/webm" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "appel_" + currentCallPeer.nom.replace(/\s+/g,"_") + "_" + new Date().toISOString().slice(0,19).replace(/[:T]/g,"-") + ".webm";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast("Enregistrement telecharge sur votre appareil");
}

function endCall() {
  if (isRecording) stopRecording();
  if (currentCallId) {
    fbGet("/pr_calls/" + currentCallId, c => {
      if (c && !["missed","declined","declined-auto"].includes(c.status)) {
        fbPatch("/pr_calls/" + currentCallId, { status: "ended", endedAt: nowTs() });
        logCallEnd(currentCallId, c, "done");
      }
    });
  }
  resetCallState();
}

function resetCallState() {
  stopRingtone();
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  remoteStream = null;
  clearInterval(callPollTimer);
  if (pollForRemoteCandidates._t) Object.values(pollForRemoteCandidates._t).forEach(clearInterval);
  appliedCandidates = {};
  document.getElementById("modal-call").classList.remove("open");
  document.getElementById("modal-incoming").classList.remove("open");
  document.getElementById("local-video").classList.add("hidden");
  document.getElementById("btn-mute").classList.remove("on");
  document.getElementById("btn-cam").classList.remove("on");
  currentCallId = null; currentCallPeer = null; currentCallType = null;
  refreshCallLog();
}

function logCallEnd(callId, call, outcome) {
  const otherUid = call.from === currentUser.id ? call.to : call.from;
  fbGet("/pr_users/" + otherUid, u => {
    const entry = { with: otherUid, nom: u ? u.nom : "Inconnu", type: call.type, ts: nowTs(),
      direction: call.from === currentUser.id ? "out" : "in", outcome };
    fbSet("/pr_call_log/" + currentUser.id + "/" + genUid("L-"), entry);
    refreshCallLog();
  });
}

function refreshCallLog() {
  if (!currentUser) return;
  fbGet("/pr_call_log/" + currentUser.id, (data) => {
    const wrap = document.getElementById("call-log");
    if (!data) { wrap.innerHTML = '<div class="empty-state"><div class="e-ic">📞</div>Aucun appel pour le moment.</div>'; return; }
    const arr = Object.values(data).sort((a,b) => b.ts - a.ts).slice(0, 50);
    wrap.innerHTML = arr.map(e => {
      const dirClass = e.outcome === "missed" ? "missed" : (e.direction === "out" ? "out" : "in");
      const dirLabel = e.outcome === "missed" ? "Manque" : (e.direction === "out" ? "Sortant" : "Entrant");
      const icon = e.type === "video" ? "🎥" : "📞";
      return `<div class="call-log-row">
        <div class="avatar" style="width:38px;height:38px;font-size:0.8rem">${initials(e.nom)}</div>
        <div class="pin-info"><div class="pin-name" style="font-size:0.86rem">${e.nom}</div><div class="call-dir ${dirClass}">${icon} ${dirLabel}</div></div>
        <div class="muted" style="font-size:0.72rem">${new Date(e.ts).toLocaleDateString('fr-FR')} ${fmtTime(e.ts)}</div>
      </div>`;
    }).join("");
  });
}

function playRingtone() {
  try {
    if (!playRingtone._ctx) playRingtone._ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = playRingtone._ctx;
    stopRingtone();
    ringtoneTimer = setInterval(() => {
      const t = ctx.currentTime;
      [880, 660].forEach((freq, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = freq; o.type = "sine";
        g.gain.setValueAtTime(0, t + i * 0.35);
        g.gain.linearRampToValueAtTime(0.18, t + i * 0.35 + 0.05);
        g.gain.linearRampToValueAtTime(0, t + i * 0.35 + 0.3);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + i * 0.35); o.stop(t + i * 0.35 + 0.32);
      });
    }, 1400);
  } catch (e) {}
  if (window.Notification && Notification.permission === "granted") {
    new Notification("Appel entrant", { body: currentCallPeer ? currentCallPeer.nom : "" });
  }
}
function stopRingtone() {
  if (ringtoneTimer) { clearInterval(ringtoneTimer); ringtoneTimer = null; }
}

// ------------------------------------------------------------------
// 10) ASSISTANT D'ABSENCE (repond aux messages a votre place)
// ------------------------------------------------------------------
function toggleAwayMode(on) {
  currentUser.awayMode = on;
  fbPatch("/pr_users/" + currentUser.id, { awayMode: on });
  localStorage.setItem("pr_current", JSON.stringify(currentUser));
  updateStatusPill();
  showToast(on ? "Assistant d'absence active" : "Assistant d'absence desactive");
}
function saveAwayMsg() {
  const msg = gv("away-msg-input");
  if (!msg) { showToast("Le message ne peut pas etre vide"); return; }
  currentUser.awayMsg = msg;
  fbPatch("/pr_users/" + currentUser.id, { awayMsg: msg });
  localStorage.setItem("pr_current", JSON.stringify(currentUser));
  showToast("Message enregistre");
}
function saveProfile() {
  const nom = gv("set-nom"), tel = buildIntlPhone("set-cc", "set-tel"), bio = gv("set-bio"), email = gv("set-email");
  if (!nom) { showToast("Le nom ne peut pas etre vide"); return; }
  currentUser.nom = nom; currentUser.tel = tel; currentUser.bio = bio; currentUser.email = email;
  fbPatch("/pr_users/" + currentUser.id, { nom, tel, bio, email });
  localStorage.setItem("pr_current", JSON.stringify(currentUser));
  document.getElementById("me-nom").textContent = nom;
  renderMyAvatar();
  showToast("Profil mis a jour");
}

function saveBizProfile() {
  const bizName = gv("set-biz-name"), bizDesc = gv("set-biz-desc"), bizHours = gv("set-biz-hours"), bizAddr = gv("set-biz-addr");
  Object.assign(currentUser, { bizName, bizDesc, bizHours, bizAddr });
  fbPatch("/pr_users/" + currentUser.id, { bizName, bizDesc, bizHours, bizAddr });
  localStorage.setItem("pr_current", JSON.stringify(currentUser));
  showToast("Profil professionnel enregistre");
}

document.addEventListener("change", (e) => {
  if (e.target && (e.target.id === "profile-photo-camera" || e.target.id === "profile-photo-gallery") && e.target.files[0]) {
    compressImage(e.target.files[0], 500, 0.7).then(dataUrl => {
      currentUser.photo = dataUrl;
      fbPatch("/pr_users/" + currentUser.id, { photo: dataUrl }, (ok) => {
        if (!ok) { showToast("Photo trop lourde, reessayez avec une autre"); return; }
        localStorage.setItem("pr_current", JSON.stringify(currentUser));
        renderMyAvatar();
        showToast("Photo de profil mise a jour");
      });
    }).catch(() => showToast("Photo illisible, reessayez"));
  }
});

// Auto-repond aux messages entrants quand l'assistant est actif et qu'on ne consulte pas la conversation
let assistantRepliedTo = {};
function assistantAutoReplyWatcher() {
  if (!currentUser || !currentUser.awayMode) return;
  getAcceptedContacts(list => {
    list.forEach(c => {
      const cid = convoId(currentUser.id, c.uid);
      fbGet("/pr_conversations/" + cid + "/messages", msgs => {
        if (!msgs) return;
        const arr = Object.entries(msgs).sort((a,b) => a[1].ts - b[1].ts);
        const lastMsg = arr[arr.length - 1];
        if (!lastMsg) return;
        const [mid, m] = lastMsg;
        if (m.from === currentUser.id || m.auto) return;
        if (assistantRepliedTo[mid]) return;
        if (currentChatUid === c.uid) return; // l'utilisateur repond lui-meme en ce moment
        // Ne repond que si aucune reponse automatique n'a deja suivi ce message
        assistantRepliedTo[mid] = true;
        sendChatMessage(true, currentUser.awayMsg, c.uid);
      });
    });
  });
}
setInterval(assistantAutoReplyWatcher, 6000);

function requestNotifPermission() {
  if (!("Notification" in window)) { showToast("Notifications non supportees sur ce navigateur"); return; }
  Notification.requestPermission().then(p => {
    showToast(p === "granted" ? "Notifications activees" : "Notifications refusees");
  });
}

// ------------------------------------------------------------------
// 12) CONTACTS DU TELEPHONE + NUMEROS EXTERNES (appels/SMS reseau reels)
// ------------------------------------------------------------------
// Import via l'API native du navigateur (Chrome/Android uniquement — la personne choisit
// elle-meme quel(s) contact(s) partager, rien n'est lu sans son geste explicite).
async function importFromPhoneContacts() {
  if (!("contacts" in navigator) || !("ContactsManager" in window)) {
    showToast("Votre navigateur ne permet pas cet import direct. Ajoutez le numero manuellement ci-dessous.");
    setContactTabByName("external");
    return;
  }
  try {
    const props = ["name", "tel"];
    const opts = { multiple: true };
    const picked = await navigator.contacts.select(props, opts);
    if (!picked.length) return;
    const list = getExternalContacts();
    picked.forEach(p => {
      const nom = (p.name && p.name[0]) || "Contact";
      const tel = (p.tel && p.tel[0]) || "";
      if (tel && !list.find(c => c.tel === tel)) list.push({ nom, tel, id: genUid("EXT-") });
    });
    saveExternalContacts(list);
    showToast(picked.length + " contact(s) importe(s)");
    setContactTabByName("external");
  } catch (e) {
    showToast("Import annule ou non autorise");
  }
}
function setContactTabByName(name) {
  const el = document.querySelector('.tab-chip[data-t="' + name + '"]');
  if (el) setContactTab(name, el);
}

function getExternalContacts() {
  try { return JSON.parse(localStorage.getItem("pr_external_contacts") || "[]"); }
  catch (e) { return []; }
}
function saveExternalContacts(list) {
  localStorage.setItem("pr_external_contacts", JSON.stringify(list));
}
function addExternalContactManual() {
  const nom = prompt("Nom du contact ?");
  if (!nom) return;
  const tel = prompt("Numero de telephone ?");
  if (!tel) return;
  const list = getExternalContacts();
  list.push({ nom, tel, id: genUid("EXT-") });
  saveExternalContacts(list);
  refreshContacts();
}
function removeExternalContact(id) {
  saveExternalContacts(getExternalContacts().filter(c => c.id !== id));
  refreshContacts();
}
function renderExternalContacts() {
  const listEl = document.getElementById("contacts-list");
  const list = getExternalContacts();
  let html = `
    <div class="card">
      <div class="card-h">📱 Composer un numero</div>
      <input class="inp" id="dialer-number" type="tel" inputmode="tel" placeholder="Ex: +225 07 00 00 00 00" style="font-size:1.2rem;text-align:center;letter-spacing:1px"/>
      <div class="dialpad" id="dialpad-grid"></div>
      <div class="row2" style="margin-top:12px">
        <a class="btn btn-teal" id="dialer-call-btn" href="tel:" style="text-decoration:none">📞 Appeler</a>
        <a class="btn btn-primary" id="dialer-sms-btn" href="sms:" style="text-decoration:none">💬 SMS</a>
      </div>
      <button class="btn btn-ghost" style="margin-top:10px" onclick="dialerClear()">⌫ Effacer</button>
    </div>

    <div class="card">
      <div class="card-h">✉️ Envoyer un email</div>
      <input class="inp" id="email-to-input" type="email" placeholder="adresse@email.com"/>
      <label class="lbl">Sujet (optionnel)</label>
      <input class="inp" id="email-subject-input" placeholder="Sujet du message"/>
      <label class="lbl">Message (optionnel)</label>
      <textarea class="ta" id="email-body-input" placeholder="Votre message..." style="min-height:60px"></textarea>
      <a class="btn btn-primary" id="email-send-btn" href="mailto:" style="text-decoration:none;margin-top:12px">✉️ Ouvrir dans mon app email</a>
    </div>

    <button class="btn btn-ghost" style="margin-bottom:12px" onclick="addExternalContactManual()">+ Enregistrer un numero dans mes contacts</button>`;
  if (!list.length) {
    html += '<div class="empty-state"><div class="e-ic">📱</div>Ces actions ouvrent votre application telephone/SMS/email habituelle — ca passe par votre reseau normal, pas par Internet.</div>';
    listEl.innerHTML = html;
    setupDialpad();
    return;
  }
  html += '<p class="muted" style="margin-bottom:10px">Vos numeros enregistres :</p>';
  list.forEach(c => {
    html += `<div class="contact-row">
      <div class="avatar">${initials(c.nom)}</div>
      <div class="pin-info"><div class="pin-name">${escapeHtml(c.nom)}</div><div class="pin-sub">${escapeHtml(c.tel)}</div></div>
      <div class="contact-acts">
        <a class="ic-btn ic-call" href="tel:+${normalizePhoneForLink(c.tel)}" style="text-decoration:none">📞</a>
        <a class="ic-btn ic-msg" href="sms:${encodeURIComponent(c.tel)}" style="text-decoration:none">💬</a>
        <button class="ic-btn" style="background:var(--rose-pale);color:#B3184A" onclick="removeExternalContact('${c.id}')">✕</button>
      </div>
    </div>`;
  });
  listEl.innerHTML = html;
  setupDialpad();
}

function setupDialpad() {
  const grid = document.getElementById("dialpad-grid");
  if (!grid) return;
  const keys = ["1","2","3","4","5","6","7","8","9","*","0","#"];
  grid.innerHTML = keys.map(k => `<button type="button" class="dialpad-key" onclick="dialerPress('${k}')">${k}</button>`).join("");
  updateDialerLinks();
  document.getElementById("dialer-number").addEventListener("input", updateDialerLinks);
  document.getElementById("email-to-input").addEventListener("input", updateEmailLink);
  document.getElementById("email-subject-input").addEventListener("input", updateEmailLink);
  document.getElementById("email-body-input").addEventListener("input", updateEmailLink);
}
function dialerPress(k) {
  const inp = document.getElementById("dialer-number");
  inp.value += k;
  updateDialerLinks();
}
function dialerClear() {
  document.getElementById("dialer-number").value = "";
  updateDialerLinks();
}
function updateDialerLinks() {
  const num = gv("dialer-number");
  document.getElementById("dialer-call-btn").href = "tel:" + encodeURIComponent(num);
  document.getElementById("dialer-sms-btn").href = "sms:" + encodeURIComponent(num);
}
function updateEmailLink() {
  const to = gv("email-to-input"), subj = gv("email-subject-input"), body = gv("email-body-input");
  let href = "mailto:" + encodeURIComponent(to);
  const params = [];
  if (subj) params.push("subject=" + encodeURIComponent(subj));
  if (body) params.push("body=" + encodeURIComponent(body));
  if (params.length) href += "?" + params.join("&");
  document.getElementById("email-send-btn").href = href;
}

// ------------------------------------------------------------------
// 13) STATUTS (comme des "stories", visibles 24h par vos proches acceptes)
// ------------------------------------------------------------------
function compressImage(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) { height *= maxDim / width; width = maxDim; }
      else if (height > maxDim) { width *= maxDim / height; height = maxDim; }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality || 0.6));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image illisible")); };
    img.src = url;
  });
}

let pendingStatusPhoto = null;
let pendingStatusVideo = null;
const MAX_STATUS_VIDEO_BYTES = 20 * 1024 * 1024; // ~20 Mo

function openStatusCreate() {
  document.getElementById("status-text-input").value = "";
  ["status-photo-camera","status-photo-gallery","status-video-gallery"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  document.getElementById("status-photo-preview").classList.add("hidden");
  document.getElementById("btn-remove-status-photo").classList.add("hidden");
  document.getElementById("status-video-preview").classList.add("hidden");
  document.getElementById("btn-remove-status-video").classList.add("hidden");
  pendingStatusPhoto = null;
  pendingStatusVideo = null;
  document.getElementById("modal-status-create").classList.add("open");
}
function closeStatusCreate() {
  document.getElementById("modal-status-create").classList.remove("open");
}

document.addEventListener("change", (e) => {
  if (!e.target) return;
  if ((e.target.id === "status-photo-camera" || e.target.id === "status-photo-gallery") && e.target.files[0]) {
    compressImage(e.target.files[0], 900, 0.65).then(dataUrl => {
      pendingStatusPhoto = dataUrl;
      const prev = document.getElementById("status-photo-preview");
      prev.src = dataUrl; prev.classList.remove("hidden");
      document.getElementById("btn-remove-status-photo").classList.remove("hidden");
    }).catch(() => showToast("Photo illisible, reessayez"));
  }
  if ((e.target.id === "status-video-camera" || e.target.id === "status-video-gallery") && e.target.files[0]) {
    const file = e.target.files[0];
    if (file.size > MAX_STATUS_VIDEO_BYTES) {
      showToast("Cette video est trop lourde (max 20 Mo). Choisissez un clip plus court.");
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingStatusVideo = reader.result;
      const v = document.getElementById("status-video-preview");
      v.src = reader.result; v.classList.remove("hidden");
      document.getElementById("btn-remove-status-video").classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  }
});
function removeStatusPhoto() {
  pendingStatusPhoto = null;
  document.getElementById("status-photo-preview").classList.add("hidden");
  document.getElementById("btn-remove-status-photo").classList.add("hidden");
}
// ------------------------------------------------------------------
// ENREGISTREUR VIDEO MAISON POUR LES STATUTS — contrairement a la camera
// native du telephone, celui-ci est controle par l'app et peut donc
// arreter automatiquement l'enregistrement des que 20 Mo sont atteints.
// ------------------------------------------------------------------
let statusRecordStream = null, statusRecorder = null, statusRecordedChunks = [], statusRecordedBytes = 0;
async function openStatusVideoRecorder() {
  const overlay = document.getElementById("modal-video-recorder");
  overlay.classList.remove("hidden");
  try {
    statusRecordStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: true });
  } catch (e) {
    showToast("Impossible d'acceder a la camera : " + e.message);
    overlay.classList.add("hidden");
    return;
  }
  const preview = document.getElementById("rec-preview");
  preview.srcObject = statusRecordStream;
  statusRecordedChunks = []; statusRecordedBytes = 0;
  document.getElementById("rec-size-status").textContent = "0.0 Mo / 20 Mo — pret a filmer";
  document.getElementById("rec-start-btn").classList.remove("hidden");
  document.getElementById("rec-stop-btn").classList.add("hidden");
}
function startStatusRecording() {
  if (!statusRecordStream) return;
  statusRecordedChunks = []; statusRecordedBytes = 0;
  let mimeType = "video/webm;codecs=vp8,opus";
  if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = "video/webm";
  statusRecorder = new MediaRecorder(statusRecordStream, { mimeType });
  statusRecorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    statusRecordedChunks.push(e.data);
    statusRecordedBytes += e.data.size;
    document.getElementById("rec-size-status").textContent = (statusRecordedBytes / 1024 / 1024).toFixed(1) + " Mo / 20 Mo";
    if (statusRecordedBytes >= MAX_STATUS_VIDEO_BYTES) {
      showToast("⏹️ Limite de 20 Mo atteinte — enregistrement arrete automatiquement");
      stopStatusRecording();
    }
  };
  statusRecorder.onstop = () => {
    const blob = new Blob(statusRecordedChunks, { type: "video/webm" });
    const reader = new FileReader();
    reader.onload = () => {
      pendingStatusVideo = reader.result;
      const v = document.getElementById("status-video-preview");
      v.src = reader.result; v.classList.remove("hidden");
      document.getElementById("btn-remove-status-video").classList.remove("hidden");
    };
    reader.readAsDataURL(blob);
    closeStatusVideoRecorder();
  };
  statusRecorder.start(500); // on verifie la taille toutes les 500ms
  document.getElementById("rec-start-btn").classList.add("hidden");
  document.getElementById("rec-stop-btn").classList.remove("hidden");
}
function stopStatusRecording() {
  if (statusRecorder && statusRecorder.state !== "inactive") statusRecorder.stop();
  else closeStatusVideoRecorder();
}
function closeStatusVideoRecorder() {
  document.getElementById("modal-video-recorder").classList.add("hidden");
  if (statusRecordStream) { statusRecordStream.getTracks().forEach(t => t.stop()); statusRecordStream = null; }
}

function removeStatusVideo() {
  pendingStatusVideo = null;
  const v = document.getElementById("status-video-preview");
  v.src = ""; v.classList.add("hidden");
  document.getElementById("btn-remove-status-video").classList.add("hidden");
}

function submitStatus() {
  const text = gv("status-text-input");
  if (!text && !pendingStatusPhoto && !pendingStatusVideo) { showToast("Ecrivez un texte, ajoutez une photo ou une video"); return; }
  const id = genUid("S-");
  const entry = {
    text,
    photo: pendingStatusVideo ? null : (pendingStatusPhoto || null),
    video: pendingStatusVideo || null,
    ts: nowTs(), expiresAt: nowTs() + 24 * 3600 * 1000
  };
  fbSet("/pr_statuses/" + currentUser.id + "/" + id, entry, (ok) => {
    if (!ok) { showToast("Erreur d'envoi — le fichier est peut-etre trop lourd"); return; }
    closeStatusCreate();
    showToast("Statut publie pour 24h");
    refreshStatuses();
  });
}

function refreshStatuses() {
  if (!currentUser) return;
  const avatarEl = document.getElementById("mystatus-avatar");
  fbGet("/pr_statuses/" + currentUser.id, mine => {
    const activeMine = mine ? Object.values(mine).filter(s => s.expiresAt > nowTs()) : [];
    avatarEl.textContent = activeMine.length ? "⭐" : "+";
  });
  getAcceptedContacts(list => {
    const wrap = document.getElementById("statuses-list");
    if (!list.length) { wrap.innerHTML = '<p class="muted center" style="margin-top:20px">Ajoutez des proches pour voir leurs statuts ici.</p>'; return; }
    let pending = list.length;
    let rows = [];
    list.forEach(c => {
      fbGet("/pr_statuses/" + c.uid, data => {
        pending--;
        const active = data ? Object.values(data).filter(s => s.expiresAt > nowTs()) : [];
        if (active.length) {
          const latest = active.sort((a,b) => b.ts - a.ts)[0];
          rows.push({ uid: c.uid, nom: c.nom, latest, count: active.length });
        }
        if (pending === 0) {
          if (!rows.length) { wrap.innerHTML = '<p class="muted center" style="margin-top:20px">Aucun statut actif chez vos proches pour le moment.</p>'; return; }
          rows.sort((a,b) => b.latest.ts - a.latest.ts);
          wrap.innerHTML = rows.map(r => `
            <div class="contact-row" onclick="viewStatus('${r.uid}','${r.nom.replace(/'/g,"")}')">
              <div class="avatar" style="border:2.5px solid var(--amber)">${initials(r.nom)}</div>
              <div class="pin-info"><div class="pin-name">${escapeHtml(r.nom)}</div><div class="pin-sub">${r.latest.video ? '🎥 ' : ''}${r.count} statut(s) · ${fmtTime(r.latest.ts)}</div></div>
            </div>`).join("");
        }
      });
    });
  });
}

function viewStatus(uid, nom) {
  fbGet("/pr_statuses/" + uid, data => {
    if (!data) return;
    const active = Object.values(data).filter(s => s.expiresAt > nowTs()).sort((a,b) => b.ts - a.ts);
    if (!active.length) { showToast("Ce statut a expire"); return; }
    const s = active[0];
    document.getElementById("statusview-avatar").textContent = initials(nom);
    document.getElementById("statusview-name").textContent = nom;
    document.getElementById("statusview-time").textContent = fmtTime(s.ts) + " · disparait dans " + Math.max(1, Math.round((s.expiresAt - nowTs()) / 3600000)) + "h";
    document.getElementById("statusview-text").textContent = s.text || "";
    const photo = document.getElementById("statusview-photo");
    const video = document.getElementById("statusview-video");
    video.pause(); video.src = "";
    if (s.video) { video.src = s.video; video.classList.remove("hidden"); photo.classList.add("hidden"); }
    else if (s.photo) { photo.src = s.photo; photo.classList.remove("hidden"); video.classList.add("hidden"); }
    else { photo.classList.add("hidden"); video.classList.add("hidden"); }
    document.getElementById("modal-status-view").style.display = "flex";
  });
}
function closeStatusView(e) {
  if (e) e.stopPropagation();
  const video = document.getElementById("statusview-video");
  video.pause();
  document.getElementById("modal-status-view").style.display = "none";
}

setInterval(() => { if (currentUser) refreshStatuses(); }, 15000);
setInterval(() => { if (currentUser && currentTabName !== "contacts") refreshContactsBadgeOnly(); }, 15000);
function refreshContactsBadgeOnly() {
  fbGet("/pr_contacts/" + currentUser.id, (data) => {
    const badge = document.getElementById("badge-contacts");
    if (!badge) return;
    const pendingInCount = data ? Object.keys(data).filter(u => data[u].status === "pending" && data[u].requestedBy !== currentUser.id).length : 0;
    if (pendingInCount > 0) { badge.textContent = pendingInCount; badge.classList.remove("hidden"); } else badge.classList.add("hidden");
  });
}

// ------------------------------------------------------------------
// 14) LOGO DE L'APPLICATION (uploadable par l'admin, visible par tous)
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// COMMUNICATION DIRECTE (WhatsApp / SMS / Appel / Email)
// Utilise cote admin (contacter un utilisateur) et cote utilisateur
// (contacter l'administrateur), avec le meme rendu.
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// DEMANDER A QUELQU'UN D'ACTIVER "PARTAGER MA POSITION EN DIRECT"
// Message pre-defini et modifiable, envoyable par WhatsApp/SMS/Appel/Email.
// Utilisable a la fois cote utilisateur (mes proches) et cote admin.
// ------------------------------------------------------------------
const INVITE_MSG_DEFAULT = "Bonjour {nom}, peux-tu activer \"Partager ma position en direct\" sur l'application Shaman Chooz Call Center ? Ca m'aiderait a te retrouver facilement. Merci !";
function getInviteMessage(nom) {
  const tpl = localStorage.getItem("pr_invite_template") || INVITE_MSG_DEFAULT;
  return tpl.replace(/\{nom\}/g, nom || "");
}
function askActivateSharing(nom, tel, email) {
  const msg = getInviteMessage(nom);
  const overlay = document.createElement("div");
  overlay.className = "modal-bg open";
  overlay.style.zIndex = "9700";
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="modal-sheet" style="max-width:420px">
      <div class="modal-handle"></div>
      <button type="button" class="icon-btn" style="position:absolute;top:14px;right:14px" onclick="this.closest('.modal-bg').remove()">✕</button>
      <div class="card-h">📨 Demander l'activation du partage</div>
      <p class="muted" style="margin:6px 0 12px">Message a envoyer a ${escapeHtml(nom || "cette personne")} (modifiable) :</p>
      <textarea class="ta" id="invite-msg-box" style="min-height:100px">${escapeHtml(msg)}</textarea>
      <button class="btn-sm btn-ghost" style="margin-top:8px" onclick="saveInviteTemplate()">💾 Enregistrer comme message par defaut</button>
      <div class="row2" style="gap:8px;margin-top:14px">
        ${tel ? `<button class="btn btn-teal" onclick="sendInviteVia('wa','${escapeHtml(tel)}')">🟢 WhatsApp</button>` : '<div></div>'}
        ${tel ? `<button class="btn btn-primary" onclick="sendInviteVia('sms','${escapeHtml(tel)}')">💬 SMS</button>` : '<div></div>'}
      </div>
      <div class="row2" style="gap:8px;margin-top:8px">
        ${tel ? `<a class="btn btn-ghost" style="text-decoration:none" href="tel:+${normalizePhoneForLink(tel)}">📞 Appeler</a>` : '<div></div>'}
        ${email ? `<button class="btn btn-ghost" onclick="sendInviteVia('email','${escapeHtml(email)}')">✉️ Email</button>` : '<div></div>'}
      </div>
      ${(!tel && !email) ? '<p class="muted center" style="margin-top:10px">Aucune coordonnee disponible pour cette personne.</p>' : ''}
    </div>`;
  document.body.appendChild(overlay);
}
function saveInviteTemplate() {
  const box = document.getElementById("invite-msg-box");
  if (!box) return;
  localStorage.setItem("pr_invite_template", box.value);
  showToast("Message par defaut enregistre pour la prochaine fois");
}
function sendInviteVia(kind, target) {
  const box = document.getElementById("invite-msg-box");
  const text = box ? box.value : getInviteMessage("");
  const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (kind === "wa") window.open(waLink(target, text), "_blank");
  else if (kind === "sms") window.location.href = "sms:+" + normalizePhoneForLink(target) + (isIOSDevice ? "&body=" : "?body=") + encodeURIComponent(text);
  else if (kind === "email") window.location.href = "mailto:" + encodeURIComponent(target) + "?subject=" + encodeURIComponent("Partage de position") + "&body=" + encodeURIComponent(text);
}

function waLink(tel, text) {
  const digits = normalizePhoneForLink(tel);
  return "https://wa.me/" + digits + (text ? "?text=" + encodeURIComponent(text) : "");
}
function renderCommButtons(tel, email, label) {
  if (!tel && !email) return '<p class="muted center" style="padding:8px 0">Aucune coordonnee renseignee pour le moment.</p>';
  let html = '<div class="row2" style="gap:8px">';
  if (tel) {
    html += `<a class="btn btn-teal" href="${waLink(tel, 'Bonjour, ')}" target="_blank" rel="noopener" style="text-decoration:none">🟢 WhatsApp</a>`;
    html += `<a class="btn btn-primary" href="sms:+${normalizePhoneForLink(tel)}" style="text-decoration:none">💬 SMS</a>`;
  }
  html += '</div><div class="row2" style="gap:8px;margin-top:8px">';
  if (tel) html += `<a class="btn btn-ghost" href="tel:+${normalizePhoneForLink(tel)}" style="text-decoration:none">📞 Appeler</a>`;
  if (email) html += `<a class="btn btn-ghost" href="mailto:${encodeURIComponent(email)}" style="text-decoration:none">✉️ Email</a>`;
  html += '</div>';
  return html;
}

function renderContactAdminButtons() {
  fbGet("/pr_config/contact", c => {
    const wrap = document.getElementById("contact-admin-buttons");
    if (!wrap) return;
    wrap.outerHTML = `<div id="contact-admin-buttons">${renderCommButtons(c && c.tel, c && c.email)}</div>`;
  });
}

function saveAdminContact() {
  const tel = buildIntlPhone("admin-contact-cc", "admin-contact-tel"), email = gv("admin-contact-email");
  fbSet("/pr_config/contact", { tel, email }, (ok) => {
    if (!ok) { showToast("Erreur d'enregistrement"); return; }
    showToast("Coordonnees mises a jour");
  });
}

function saveGoogleMapsKey() {
  const key = gv("admin-gmaps-key");
  fbSet("/pr_config/googleMapsKey", key, (ok) => {
    if (!ok) { showToast("Erreur d'enregistrement"); return; }
    showToast(key ? "Cle Google Maps enregistree — rechargez l'app pour l'utiliser" : "Cle retiree — retour a la carte gratuite");
  });
}

function loadAppLogo() {
  fbGet("/pr_config/logo", logo => {
    if (!logo) return;
    document.querySelectorAll("#brand-logo-img, #auth-logo-img").forEach(img => {
      img.src = logo; img.classList.remove("hidden");
    });
    const fb1 = document.getElementById("brand-logo-fallback"); if (fb1) fb1.classList.add("hidden");
    const fb2 = document.getElementById("auth-logo-fallback"); if (fb2) fb2.classList.add("hidden");
  });
}
function openLogoFull() {
  const img = document.getElementById("brand-logo-img");
  if (img.classList.contains("hidden") || !img.src) { showToast("Aucune photo n'a encore ete ajoutee"); return; }
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9900;display:flex;align-items:center;justify-content:center;padding:20px";
  overlay.onclick = () => overlay.remove();
  overlay.innerHTML = `<img src="${img.src}" style="max-width:100%;max-height:100%;border-radius:12px"/>`;
  document.body.appendChild(overlay);
}
// Charge le logo meme avant connexion (ecran d'authentification)
populateCountrySelect("rg-cc");
fbGet("/pr_config/logo", logo => {
  if (!logo) return;
  document.querySelectorAll("#auth-logo-img").forEach(img => { img.src = logo; img.classList.remove("hidden"); });
  const fb2 = document.getElementById("auth-logo-fallback"); if (fb2) fb2.classList.add("hidden");
});

// ------------------------------------------------------------------
// 15) ESPACE ADMINISTRATEUR
// ------------------------------------------------------------------
const ADMIN_PWD_DEFAULT = "Shaman123chooz";
let isAdmin = false;
let adminTab = "users";

function openAdminLogin() { document.getElementById("scr-admin-login").classList.remove("hidden"); }
function closeAdminLogin() { document.getElementById("scr-admin-login").classList.add("hidden"); document.getElementById("admin-pwd-input").value = ""; }

function doAdminLogin() {
  const pwd = gv("admin-pwd-input");
  if (!pwd) { showToast("Entrez le mot de passe administrateur"); return; }
  const btn = document.getElementById("admin-login-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Verification..."; }
  const restoreBtn = () => { if (btn) { btn.disabled = false; btn.textContent = "Entrer"; } };
  fbGet("/pr_config/adminPwdHash", storedHash => {
    restoreBtn();
    const ok = storedHash ? (hashPwd(pwd) === storedHash) : (pwd === ADMIN_PWD_DEFAULT);
    if (!ok) { showToast("Mot de passe incorrect"); return; }
    isAdmin = true;
    closeAdminLogin();
    document.getElementById("admin-pwd-input").value = "";
    document.getElementById("scr-admin").classList.remove("hidden");
    renderAdminUsers();
    renderAdminPayments();
    setTimeout(initAdminSelfMap, 150);
    fbGet("/pr_config/logo", logo => {
      const prev = document.getElementById("admin-logo-preview");
      if (logo) { prev.style.backgroundImage = "url(" + logo + ")"; prev.style.backgroundSize = "cover"; prev.textContent = ""; }
      else prev.textContent = "📍";
    });
    fbGet("/pr_config/contact", c => {
      fillPhoneFields("admin-contact-cc", "admin-contact-tel", c && c.tel);
      document.getElementById("admin-contact-email").value = (c && c.email) || "";
    });
    fbGet("/pr_config/googleMapsKey", key => {
      document.getElementById("admin-gmaps-key").value = key || "";
    });
    document.getElementById("admin-pwd-current").value = "";
    document.getElementById("admin-pwd-new").value = "";
    renderAdminQr();
    history.pushState({ layer: "overlay", screen: "admin" }, "", "#admin");
  });
}
function closeAdmin() {
  if (history.state && history.state.layer === "overlay") history.back();
  else doCloseAdminUI();
}
function doCloseAdminUI() {
  isAdmin = false;
  document.getElementById("scr-admin").classList.add("hidden");
  if (adminSelfWatchId) { navigator.geolocation.clearWatch(adminSelfWatchId); adminSelfWatchId = null; }
  clearInterval(adminTrackSearchPollTimer);
}
function setAdminTab(t, el) {
  adminTab = t;
  document.querySelectorAll("#scr-admin .tab-chip").forEach(c => c.classList.remove("active"));
  el.classList.add("active");
  document.getElementById("admin-users-pane").classList.toggle("hidden", t !== "users");
  document.getElementById("admin-payments-pane").classList.toggle("hidden", t !== "payments");
  if (t === "users") renderAdminUsers(); else renderAdminPayments();
}

document.addEventListener("change", (e) => {
  if (e.target && e.target.id === "admin-logo-input" && e.target.files[0]) {
    compressImage(e.target.files[0], 500, 0.75).then(dataUrl => {
      fbSet("/pr_config/logo", dataUrl, (ok) => {
        if (!ok) { showToast("Erreur lors de l'envoi de la photo"); return; }
        showToast("Logo mis a jour pour tous les utilisateurs");
        loadAppLogo();
        const prev = document.getElementById("admin-logo-preview");
        prev.style.backgroundImage = "url(" + dataUrl + ")"; prev.style.backgroundSize = "cover"; prev.textContent = "";
      });
    }).catch(() => showToast("Photo illisible"));
  }
});

function renderAdminUsers() {
  fbGet("/pr_users", all => {
    const listEl = document.getElementById("admin-users-list");
    if (!all) { listEl.innerHTML = '<p class="muted center">Aucun utilisateur pour le moment.</p>'; return; }
    const q = gv("admin-user-search").toLowerCase();
    let users = Object.values(all).filter(Boolean);
    if (q) users = users.filter(u => (u.nom||"").toLowerCase().includes(q) || (u.pseudo||"").toLowerCase().includes(q) || (u.tel||"").toLowerCase().includes(q));
    users.sort((a,b) => b.createdAt - a.createdAt);
    if (!users.length) { listEl.innerHTML = '<p class="muted center">Aucun resultat.</p>'; return; }
    listEl.innerHTML = users.map(u => `
      <div class="contact-row" style="flex-wrap:wrap">
        <div class="avatar" style="${u.photo ? 'background-image:url('+u.photo+');background-size:cover;cursor:pointer' : 'cursor:pointer'}" onclick="openAdminUserDetail('${u.id}')">${u.photo ? '' : initials(u.nom)}</div>
        <div class="pin-info" onclick="openAdminUserDetail('${u.id}')" style="cursor:pointer">
          <div class="pin-name">${escapeHtml(u.nom)} ${u.blocked ? '<span style="color:var(--err);font-size:0.7rem">· BLOQUE</span>' : ''}</div>
          <div class="pin-sub">@${escapeHtml(u.pseudo)} · ${escapeHtml(u.tel||'')} · ${u.paymentStatus === 'active' ? '✅ actif' : '⏳ non actif'}</div>
        </div>
        <div class="contact-acts" style="flex-wrap:wrap;gap:6px">
          ${u.blocked
            ? `<button class="btn-sm btn-ghost" onclick="adminUnblockUser('${u.id}')">Debloquer</button>`
            : `<button class="btn-sm btn-ghost" onclick="adminBlockUser('${u.id}')">Bloquer</button>`}
          ${u.paymentStatus !== 'active'
            ? `<button class="btn-sm" style="background:var(--teal);color:#fff" onclick="adminActivateUser('${u.id}')">Activer</button>`
            : `<button class="btn-sm btn-ghost" onclick="adminDeactivateUser('${u.id}')">Desactiver</button>`}
          <button class="btn-sm btn-danger" onclick="adminDeleteUser('${u.id}','${u.nom.replace(/'/g,"")}')">Supprimer</button>
        </div>
      </div>`).join("");
  });
}
function adminBlockUser(uid) { fbPatch("/pr_users/" + uid, { blocked: true }, () => renderAdminUsers()); }
function adminUnblockUser(uid) { fbPatch("/pr_users/" + uid, { blocked: false }, () => renderAdminUsers()); }
function adminActivateUser(uid) { fbPatch("/pr_users/" + uid, { paymentStatus: "active" }, () => renderAdminUsers()); }
function adminDeactivateUser(uid) { fbPatch("/pr_users/" + uid, { paymentStatus: "unpaid" }, () => renderAdminUsers()); }
function adminDeleteUser(uid, nom) {
  if (!confirm("Supprimer definitivement le compte de " + nom + " ? Cette action est irreversible.")) return;
  fbDelete("/pr_users/" + uid, () => {
    fbDelete("/pr_payments/" + uid);
    showToast("Compte supprime");
    renderAdminUsers();
  });
}

// Flux global : toutes les factures de tous les comptes, les plus recentes en premier
function renderAdminPayments() {
  fbGet("/pr_payments", all => {
    const listEl = document.getElementById("admin-payments-list");
    const badge = document.getElementById("admin-pay-badge");
    if (!all) { listEl.innerHTML = '<p class="muted center">Aucune facture pour le moment.</p>'; badge.classList.add("hidden"); return; }
    let entries = [];
    Object.entries(all).forEach(([uid, payments]) => {
      Object.values(payments || {}).forEach(p => entries.push(p));
    });
    if (!entries.length) { listEl.innerHTML = '<p class="muted center">Aucune facture pour le moment.</p>'; badge.classList.add("hidden"); return; }
    entries.sort((a,b) => b.ts - a.ts);
    badge.textContent = entries.length; badge.classList.remove("hidden");
    listEl.innerHTML = entries.slice(0, 100).map(p => `
      <div class="card" style="cursor:pointer" onclick="openAdminUserDetail('${p.uid}')">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <b>${escapeHtml(p.nom)}</b>
          <span class="muted" style="font-size:0.72rem">${p.ts ? new Date(p.ts).toLocaleString('fr-FR') : 'Date inconnue'}</span>
        </div>
        <div class="muted" style="font-size:0.82rem;margin-top:4px">Zone : ${p.zone === 'ci' ? "Cote d'Ivoire" : 'International'} · Moyen : ${escapeHtml(p.method||'-')}</div>
        <div class="muted" style="font-size:0.82rem">Montant : <b style="color:var(--txt)">${escapeHtml(p.amount||'-')}</b> · Reference : <b style="color:var(--txt)">${escapeHtml(p.ref||'-')}</b></div>
        <div class="muted" style="font-size:0.76rem;margin-top:2px">${p.auto ? '📋 Collee automatiquement' : '⌨️ Saisie manuelle'}</div>
      </div>`).join("");
  });
}
// ------------------------------------------------------------------
// MOT DE PASSE ADMIN — modifiable a tout moment (stocke hache dans Firebase)
// ------------------------------------------------------------------
function changeAdminPassword() {
  const current = gv("admin-pwd-current"), next = gv("admin-pwd-new");
  if (!current || !next) { showToast("Remplissez les deux champs"); return; }
  if (next.length < 6) { showToast("Le nouveau mot de passe doit faire 6 caracteres minimum"); return; }
  fbGet("/pr_config/adminPwdHash", storedHash => {
    const ok = storedHash ? (hashPwd(current) === storedHash) : (current === ADMIN_PWD_DEFAULT);
    if (!ok) { showToast("Mot de passe actuel incorrect"); return; }
    fbSet("/pr_config/adminPwdHash", hashPwd(next), (writeOk) => {
      if (!writeOk) { showToast("Erreur d'enregistrement"); return; }
      showToast("Mot de passe administrateur mis a jour");
      document.getElementById("admin-pwd-current").value = "";
      document.getElementById("admin-pwd-new").value = "";
    });
  });
}

// Admin peut changer le mot de passe de n'importe quel compte utilisateur
function adminChangeUserPassword(uid, nom) {
  const next = prompt("Nouveau mot de passe pour " + nom + " (6 caracteres minimum) :");
  if (!next) return;
  if (next.length < 6) { showToast("Le mot de passe doit faire 6 caracteres minimum"); return; }
  fbPatch("/pr_users/" + uid, { mdpHash: hashPwd(next) }, (ok) => {
    showToast(ok ? "Mot de passe change pour " + nom : "Erreur lors du changement");
  });
}

// ------------------------------------------------------------------
// CODE QR DE CONNEXION
// ------------------------------------------------------------------
function getAppUrl() {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}
function renderAdminQr() {
  const wrap = document.getElementById("admin-qr-code");
  if (!wrap || typeof QRCode === "undefined") return;
  wrap.innerHTML = "";
  const url = getAppUrl();
  new QRCode(wrap, { text: url, width: 180, height: 180 });
  document.getElementById("admin-qr-url").textContent = url;
}

// ------------------------------------------------------------------
// IMPRESSION
// ------------------------------------------------------------------
function printGeneric(titleHtml, bodyHtml) {
  document.getElementById("print-area").innerHTML = `
    <div style="font-family:sans-serif;color:#111">
      <h2 style="margin-bottom:4px">${titleHtml}</h2>
      <p style="color:#666;font-size:0.85rem;margin-top:0">Shaman Chooz Call Center — ${new Date().toLocaleString('fr-FR')}</p>
      <hr/>
      ${bodyHtml}
    </div>`;
  setTimeout(() => window.print(), 100);
}
function printQrCode() {
  const url = getAppUrl();
  const qrHtml = document.getElementById("admin-qr-code").innerHTML;
  printGeneric("Code QR de connexion", `<div style="text-align:center">${qrHtml}<p style="word-break:break-all;margin-top:10px">${url}</p></div>`);
}
function printMyInfo() {
  const u = currentUser;
  const body = `
    <p><b>Nom :</b> ${escapeHtml(u.nom)}</p>
    <p><b>Pseudo :</b> @${escapeHtml(u.pseudo)}</p>
    <p><b>Telephone :</b> ${escapeHtml(u.tel||'-')}</p>
    <p><b>Email :</b> ${escapeHtml(u.email||'-')}</p>
    <p><b>Bio :</b> ${escapeHtml(u.bio||'-')}</p>
    <p><b>Membre depuis :</b> ${new Date(u.createdAt).toLocaleDateString('fr-FR')}</p>
  `;
  printGeneric("Mes informations", body);
}
function printUserSheet(uid) {
  fbGet("/pr_users/" + uid, u => {
    if (!u) return;
    fbGet("/pr_payments/" + uid, payments => {
      const list = payments ? Object.values(payments).sort((a,b) => b.ts - a.ts) : [];
      let body = `
        <p><b>Nom :</b> ${escapeHtml(u.nom)}</p>
        <p><b>Pseudo :</b> @${escapeHtml(u.pseudo)}</p>
        <p><b>Telephone :</b> ${escapeHtml(u.tel||'-')}</p>
        <p><b>Email :</b> ${escapeHtml(u.email||'-')}</p>
        <p><b>Statut :</b> ${u.paymentStatus === 'active' ? 'Actif' : 'Non actif'} ${u.blocked ? '(Bloque)' : ''}</p>
        <p><b>Membre depuis :</b> ${new Date(u.createdAt).toLocaleDateString('fr-FR')}</p>
        <h3>Historique des factures</h3>`;
      if (!list.length) body += "<p>Aucun paiement enregistre.</p>";
      else {
        body += '<table style="width:100%;border-collapse:collapse" border="1" cellpadding="6">';
        body += '<tr><th>Date</th><th>Zone</th><th>Moyen</th><th>Montant</th><th>Reference</th></tr>';
        list.forEach(p => {
          body += `<tr><td>${p.ts ? new Date(p.ts).toLocaleString('fr-FR') : '-'}</td><td>${p.zone === 'ci' ? "Cote d'Ivoire" : 'International'}</td><td>${escapeHtml(p.method||'-')}</td><td>${escapeHtml(p.amount||'-')}</td><td>${escapeHtml(p.ref||'-')}</td></tr>`;
        });
        body += '</table>';
      }
      printGeneric("Fiche compte — " + u.nom, body);
    });
  });
}

// ------------------------------------------------------------------
// SUIVI EN DIRECT D'UN UTILISATEUR (uniquement si lui-meme a active
// "Partager ma position en direct" — jamais sans son consentement)
// ------------------------------------------------------------------
let adminTrackSearchPollTimer = null;
function adminSearchTrackUsers() {
  const q = gv("admin-track-search").toLowerCase();
  const wrap = document.getElementById("admin-track-results");
  clearInterval(adminTrackSearchPollTimer);
  if (!q) { wrap.innerHTML = ""; return; }
  runAdminTrackSearch(q);
  // Tant que la recherche reste affichee, on revérifie toutes les 5s si la
  // personne vient d'activer "Partager ma position en direct".
  adminTrackSearchPollTimer = setInterval(() => {
    const current = gv("admin-track-search").toLowerCase();
    if (current === q) runAdminTrackSearch(q); else clearInterval(adminTrackSearchPollTimer);
  }, 5000);
}
function runAdminTrackSearch(q) {
  const wrap = document.getElementById("admin-track-results");
  fbGet("/pr_users", all => {
    const users = all ? Object.values(all).filter(Boolean) : [];
    const matches = users.filter(u =>
      (u.tel || "").toLowerCase().includes(q) ||
      (u.nom || "").toLowerCase().includes(q) ||
      (u.pseudo || "").toLowerCase().includes(q) ||
      (u.email || "").toLowerCase().includes(q)
    ).slice(0, 10);
    if (!matches.length) { wrap.innerHTML = '<p class="muted center">Aucun resultat</p>'; return; }
    let pending = matches.length;
    const rows = [];
    matches.forEach(u => {
      fbGet("/pr_locations/" + u.id, loc => {
        pending--;
        const live = !!(loc && loc.sharing && (nowTs() - loc.ts) < 5 * 60000);
        rows.push({ u, live });
        if (pending === 0) renderTrackResults(rows);
      });
    });
  });
}
function renderTrackResults(rows) {
  const wrap = document.getElementById("admin-track-results");
  wrap.innerHTML = rows.map(r => `
    <div class="contact-row">
      <div class="avatar" style="${r.u.photo ? 'background-image:url(' + r.u.photo + ');background-size:cover' : ''}">${r.u.photo ? '' : initials(r.u.nom)}</div>
      <div class="pin-info"><div class="pin-name">${escapeHtml(r.u.nom)}</div><div class="pin-sub">@${escapeHtml(r.u.pseudo)} · ${escapeHtml(r.u.tel || '-')}</div></div>
      ${r.live
        ? `<button class="btn-sm" style="background:var(--teal);color:#fff" onclick="adminViewUserLocation('${r.u.id}','${r.u.nom.replace(/'/g,"")}')">📍 Voir en direct</button>`
        : `<button class="btn-sm" style="background:var(--indigo);color:#fff" onclick="askActivateSharing('${(r.u.nom||'').replace(/'/g,"")}','${r.u.tel||''}','${r.u.email||''}')">📨 Demander l'activation</button>`}
    </div>`).join("");
}

let adminTrackMap = null, adminTrackMarker = null, adminTrackTimer = null;
function adminViewUserLocation(uid, nom) {
  document.getElementById("track-map-name").textContent = "📍 " + nom;
  document.getElementById("scr-admin-track-map").classList.remove("hidden");
  setTimeout(() => {
    if (!adminTrackMap) {
      adminTrackMap = L.map("admin-track-map").setView([6.827, -5.289], 6);
      adminLayers = makeBaseLayers();
      adminLayers.default.addTo(adminTrackMap);
    } else {
      adminTrackMap.invalidateSize();
    }
    updateAdminTrackPosition(uid, true);
    clearInterval(adminTrackTimer);
    adminTrackTimer = setInterval(() => updateAdminTrackPosition(uid, false), 5000);
  }, 100);
}
function updateAdminTrackPosition(uid, firstLoad) {
  fbGet("/pr_locations/" + uid, loc => {
    if (!loc || !loc.sharing) {
      showToast("Cette personne ne partage plus sa position");
      closeAdminTrackMap();
      return;
    }
    if (adminTrackMarker) adminTrackMarker.setLatLng([loc.lat, loc.lng]);
    else adminTrackMarker = L.circleMarker([loc.lat, loc.lng], { radius: 10, color: "#4A3AFF", fillColor: "#6A5AFF", fillOpacity: 0.9, weight: 3 }).addTo(adminTrackMap);
    if (firstLoad) adminTrackMap.setView([loc.lat, loc.lng], 15);
    else adminTrackMap.panTo([loc.lat, loc.lng]);
  });
}
function closeAdminTrackMap() {
  clearInterval(adminTrackTimer);
  document.getElementById("scr-admin-track-map").classList.add("hidden");
}

// ------------------------------------------------------------------
// "ME SITUER" — l'administrateur voit sa propre position sur la carte,
// pour s'orienter quand il sort (aucun rapport avec le suivi des autres).
// ------------------------------------------------------------------
let adminSelfMap = null, adminSelfLayers = null, adminSelfMarker = null, adminSelfWatchId = null;
function initAdminSelfMap() {
  const statusEl = document.getElementById("admin-self-map-status");
  if (!adminSelfMap) {
    adminSelfMap = L.map("admin-self-map", { zoomControl: true }).setView([6.827, -5.289], 6);
    adminSelfLayers = makeBaseLayers();
    adminSelfLayers.default.addTo(adminSelfMap);
  } else {
    setTimeout(() => adminSelfMap.invalidateSize(), 100);
  }
  if (!navigator.geolocation) { if (statusEl) statusEl.textContent = "Geolocalisation non disponible sur cet appareil"; return; }
  if (adminSelfWatchId) navigator.geolocation.clearWatch(adminSelfWatchId);
  if (statusEl) statusEl.textContent = "Localisation en cours...";
  adminSelfWatchId = navigator.geolocation.watchPosition(pos => {
    const { latitude, longitude, accuracy } = pos.coords;
    if (adminSelfMarker) adminSelfMarker.setLatLng([latitude, longitude]);
    else adminSelfMarker = L.circleMarker([latitude, longitude], { radius: 9, color: "#4A3AFF", fillColor: "#6A5AFF", fillOpacity: 0.9, weight: 3 }).addTo(adminSelfMap).bindPopup("Vous");
    if (statusEl) statusEl.textContent = "Position a jour (precision ~" + Math.round(accuracy) + " m)";
  }, err => {
    if (statusEl) statusEl.textContent = "Impossible d'acceder a votre position : " + err.message;
  }, { enableHighAccuracy: true, maximumAge: 5000 });
  navigator.geolocation.getCurrentPosition(pos => {
    adminSelfMap.setView([pos.coords.latitude, pos.coords.longitude], 15);
  }, () => {}, { timeout: 5000 });
}
function centerAdminSelfMap() {
  if (!adminSelfMap) return;
  navigator.geolocation.getCurrentPosition(pos => {
    adminSelfMap.setView([pos.coords.latitude, pos.coords.longitude], 16);
  }, () => showToast("Impossible d'acceder a votre position"), { enableHighAccuracy: true, timeout: 5000 });
}
function setAdminSelfMapView(which) { switchBaseLayer(adminSelfMap, adminSelfLayers, which, "admin-self-map-layer-switch"); }

// ------------------------------------------------------------------
// PARTAGER LE LIEN DE L'APPLICATION (fonctionne meme si la barre du
// navigateur n'est pas visible, via le menu de partage natif du telephone)
// ------------------------------------------------------------------
function shareAppLink() {
  const url = location.origin + location.pathname;
  if (navigator.share) {
    navigator.share({ title: "Shaman Chooz Call Center", text: "Rejoins-moi sur l'application Shaman Chooz Call Center :", url }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => showToast("Lien copie ! Vous pouvez le coller sur WhatsApp, Facebook...")).catch(() => showToast(url));
  } else {
    showToast(url);
  }
}

function openAdminUserDetail(uid) {
  fbGet("/pr_users/" + uid, u => {
    if (!u) return;
    fbGet("/pr_payments/" + uid, payments => {
      fbGet("/pr_locations/" + uid, loc => {
      const live = !!(loc && loc.sharing && (nowTs() - loc.ts) < 5 * 60000);
      const list = payments ? Object.values(payments).sort((a,b) => b.ts - a.ts) : [];
      let html = `
        <div class="center" style="margin-bottom:16px">
          <div class="avatar" style="width:70px;height:70px;font-size:1.5rem;margin:0 auto 10px;${u.photo ? 'background-image:url('+u.photo+');background-size:cover' : ''}">${u.photo ? '' : initials(u.nom)}</div>
          <div style="font-weight:800;font-size:1.1rem">${escapeHtml(u.nom)}</div>
          <div class="muted">@${escapeHtml(u.pseudo)} · ${escapeHtml(u.tel||'')}</div>
          <div class="muted" style="margin-top:4px">${u.paymentStatus === 'active' ? '✅ Compte actif' : '⏳ Non actif'} ${u.blocked ? '· 🚫 Bloque' : ''}</div>
        </div>
        <div class="lbl" style="margin-top:0">Position en direct</div>
        ${live
          ? `<button class="btn btn-teal" style="margin-bottom:14px" onclick="closeProfileModal();adminViewUserLocation('${u.id}','${u.nom.replace(/'/g,"")}')">📍 Voir sa position en direct</button>`
          : `<p class="muted" style="margin-bottom:14px">Cette personne ne partage pas sa position en ce moment.</p>`}
        <div class="lbl" style="margin-top:0">Contacter cette personne</div>
        ${renderCommButtons(u.tel, u.email)}
        <div class="lbl">Gerer le compte</div>
        <div class="row2" style="margin-bottom:14px">
          ${u.paymentStatus !== 'active'
            ? `<button class="btn btn-teal" onclick="adminActivateUser('${u.id}');closeProfileModal()">✓ Activer le compte</button>`
            : `<button class="btn btn-ghost" onclick="adminDeactivateUser('${u.id}');closeProfileModal()">Desactiver le compte</button>`}
          ${u.blocked
            ? `<button class="btn btn-ghost" onclick="adminUnblockUser('${u.id}');closeProfileModal()">Debloquer</button>`
            : `<button class="btn btn-danger" onclick="adminBlockUser('${u.id}');closeProfileModal()">Bloquer</button>`}
        </div>
        <button class="btn btn-ghost" style="margin-bottom:14px" onclick="adminDeleteUser('${u.id}','${u.nom.replace(/'/g,"")}');closeProfileModal()">🗑️ Supprimer ce compte</button>
        <button class="btn btn-ghost" style="margin-bottom:14px" onclick="adminChangeUserPassword('${u.id}','${u.nom.replace(/'/g,"")}')">🔑 Changer le mot de passe de ce compte</button>
        <button class="btn btn-ghost" style="margin-bottom:14px" onclick="printUserSheet('${u.id}')">🖨️ Imprimer la fiche complete</button>
        <div class="lbl" style="margin-top:0">Historique des factures (${list.length})</div>`;
      if (!list.length) {
        html += '<p class="muted center" style="padding:10px 0">Aucun paiement enregistre pour ce compte.</p>';
      } else {
        list.forEach(p => {
          html += `<div class="card" style="margin-bottom:8px">
            <div style="display:flex;justify-content:space-between"><b>${escapeHtml(p.method||'-')}</b><span class="muted" style="font-size:0.72rem">${p.ts ? new Date(p.ts).toLocaleString('fr-FR') : 'Date inconnue'}</span></div>
            <div class="muted" style="font-size:0.82rem">Zone : ${p.zone === 'ci' ? "Cote d'Ivoire" : 'International'} · Montant : <b style="color:var(--txt)">${escapeHtml(p.amount||'-')}</b></div>
            ${p.myNumber ? `<div class="muted" style="font-size:0.82rem">Numero payeur : ${escapeHtml(p.myNumber)}</div>` : ''}
            <div class="muted" style="font-size:0.82rem">Reference : <b style="color:var(--txt)">${escapeHtml(p.ref||'-')}</b></div>
            <div class="muted" style="font-size:0.76rem;margin-top:2px">${p.auto ? '📋 Collee automatiquement' : '⌨️ Saisie manuelle'}</div>
          </div>`;
        });
      }
      document.getElementById("profile-modal-body").innerHTML = html;
      document.getElementById("modal-profile").classList.add("open");
      });
    });
  });
}

// ------------------------------------------------------------------
// 11) DEMARRAGE
// ------------------------------------------------------------------
window.addEventListener("load", () => {
  const saved = localStorage.getItem("pr_current");
  if (saved) {
    try { currentUser = JSON.parse(saved); enterApp(); } catch(e) {}
  }
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  }
});
