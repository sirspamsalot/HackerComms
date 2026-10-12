// flasher.js — adds the HackerComms channel to a Meshtastic radio in the first
// empty secondary slot. Existing channels are read, shown, and never touched.
import {
  Role, MAX_CHANNELS, Admin, encodeChannel, encodeAdminToRadio, encodeWantConfig,
  encodeChannelSet, decodeFromRadio, b64ToBytes, bytesToB64, bytesEqual, randomId,
} from "./meshproto.js";
import { SerialTransport, BleTransport } from "./transports.js";

const CHANNEL = {
  name: "HackerComms",
  psk: b64ToBytes("6IzsaoVhx1ETWeWuu0dUWMLqItvYJLbRzwgTAKCfvtY="),
};

const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ui = {
  log: $("#log"),
  status: $("#status"),
  slots: $("#slots"),
  plan: $("#plan"),
  btnSerial: $("#connect-serial"),
  btnBle: $("#connect-ble"),
  btnWrite: $("#write"),
  btnDisconnect: $("#disconnect"),
  device: $("#device"),
};

let link = null;
let state = fresh();
function fresh() {
  return { myNodeNum: 0, channels: [], firmware: "", owner: "", targetIndex: -1, mode: null, locked: false };
}

// ---------- logging / status ----------
function log(msg, kind = "info") {
  const line = document.createElement("div");
  line.className = `log-line log-${kind}`;
  const t = new Date().toLocaleTimeString([], { hour12: false });
  line.innerHTML = `<span class="log-t">${t}</span> `;
  line.append(document.createTextNode(msg));
  ui.log.append(line);
  ui.log.scrollTop = ui.log.scrollHeight;
}
function setStatus(text, kind = "idle") {
  ui.status.textContent = text;
  ui.status.dataset.kind = kind;
}
function setBusy(busy) {
  for (const b of [ui.btnSerial, ui.btnBle, ui.btnWrite]) b.disabled = busy || b.dataset.locked === "1";
}

// ---------- config download ----------
let waiter = null;
function onFrame(frame) {
  let msg;
  try { msg = decodeFromRadio(frame); } catch (e) { return; }
  switch (msg.type) {
    case "myInfo": state.myNodeNum = msg.myNodeNum; break;
    case "metadata": state.firmware = msg.firmware; break;
    case "nodeInfo":
      if (msg.num && msg.num === state.myNodeNum) state.owner = msg.longName || msg.shortName;
      break;
    case "channel": state.channels[msg.channel.index] = msg.channel; break;
    case "lockdown": if (msg.state === 2 || msg.state === 1) state.locked = true; break;
    case "rebooted": log("Radio reported a reboot.", "warn"); break;
    case "configComplete": if (waiter && msg.id === waiter.id) { waiter.resolve(); waiter = null; } break;
  }
}

async function downloadConfig() {
  state.channels = [];
  const id = randomId();
  const done = new Promise((resolve, reject) => {
    waiter = { id, resolve };
    setTimeout(() => reject(new Error("Timed out waiting for the radio's config. Is it running Meshtastic firmware?")), 25000);
  });
  await link.send(encodeWantConfig(id));
  await done;
}

// ---------- planning ----------
const isHackerComms = (c) => c && c.role !== Role.DISABLED && c.name === CHANNEL.name;

function plan() {
  const chans = state.channels;
  const existing = chans.find(isHackerComms);
  if (existing && bytesEqual(existing.psk, CHANNEL.psk)) {
    return { mode: "present", index: existing.index };
  }
  if (existing) return { mode: "stale", index: existing.index };
  for (let i = 1; i < MAX_CHANNELS; i++) {
    const c = chans[i];
    if (!c || c.role === Role.DISABLED) return { mode: "add", index: i };
  }
  return { mode: "full", index: -1 };
}

function roleLabel(c) {
  if (!c || c.role === Role.DISABLED) return "empty";
  return c.role === Role.PRIMARY ? "primary" : "secondary";
}

function renderSlots() {
  ui.slots.innerHTML = "";
  for (let i = 0; i < MAX_CHANNELS; i++) {
    const c = state.channels[i];
    const el = document.createElement("li");
    const role = roleLabel(c);
    el.className = `slot slot-${role}`;
    if (i === state.targetIndex) el.classList.add(state.mode === "present" ? "slot-ok" : "slot-target");
    const name = role === "empty" ? "—" : (c.name || (i === 0 ? "(default)" : "(unnamed)"));
    el.innerHTML = `<span class="slot-idx">CH${i}</span><span class="slot-name"></span><span class="slot-role">${role}</span>`;
    el.querySelector(".slot-name").textContent = name;
    if (i === state.targetIndex && state.mode === "add") el.querySelector(".slot-role").innerHTML = '→ <span class="keep-case">HackerComms</span>';
    if (i === state.targetIndex && state.mode === "stale") el.querySelector(".slot-role").textContent = "→ update key";
    ui.slots.append(el);
  }
}

function renderPlan() {
  const p = $("#plan-text");
  ui.btnWrite.hidden = true;
  ui.btnWrite.dataset.locked = "0";
  switch (state.mode) {
    case "present":
      p.textContent = `HackerComms is already on this radio (CH${state.targetIndex}). Nothing to do.`;
      setStatus("Already installed", "ok");
      break;
    case "add":
      p.textContent = `CH${state.targetIndex} is empty. HackerComms will be written there as a secondary channel. Your other channels stay exactly as they are.`;
      ui.btnWrite.innerHTML = `Add <span class="keep-case">HackerComms</span> to CH${state.targetIndex}`;
      ui.btnWrite.hidden = false;
      setStatus("Ready to write", "ready");
      break;
    case "stale":
      p.textContent = `A channel named HackerComms is on CH${state.targetIndex} but with a different key. You can update just that slot to the current key; nothing else changes.`;
      ui.btnWrite.textContent = `Update key on CH${state.targetIndex}`;
      ui.btnWrite.hidden = false;
      setStatus("Old key found", "warn");
      break;
    case "full":
      p.textContent = "All 8 channel slots are in use. Free one up in the Meshtastic app first — this tool will not overwrite an existing channel.";
      setStatus("No free slot", "err");
      break;
  }
  ui.plan.hidden = false;
}

// ---------- actions ----------
async function connect(Kind) {
  if (!Kind.supported()) {
    log(Kind === SerialTransport
      ? "Web Serial isn't available in this browser. Use Chrome, Edge or Opera on desktop."
      : "Web Bluetooth isn't available in this browser. Use Chrome or Edge on desktop or Android.", "err");
    return;
  }
  setBusy(true);
  state = fresh();
  ui.plan.hidden = true;
  try {
    link = new Kind();
    link.onFromRadio(onFrame);
    link.onClose = () => { log("Link to the radio closed.", "warn"); afterDisconnect(); };
    setStatus("Connecting…", "busy");
    await link.connect();
    log(`Connected over ${Kind === SerialTransport ? "USB serial" : "Bluetooth"}.`);
    setStatus("Reading channels…", "busy");
    await downloadConfig();
    if (state.locked) throw new Error("This radio is locked. Unlock it in the Meshtastic app, then try again.");
    if (!state.myNodeNum) throw new Error("The radio didn't report its node number.");
    const id = `!${state.myNodeNum.toString(16).padStart(8, "0")}`;
    ui.device.textContent = [state.owner, id, state.firmware && `fw ${state.firmware}`].filter(Boolean).join(" · ");
    log(`Read ${state.channels.filter(Boolean).length} channel slots from ${id}.`);
    const p = plan();
    state.mode = p.mode; state.targetIndex = p.index;
    renderSlots();
    renderPlan();
    ui.btnDisconnect.hidden = false;
  } catch (e) {
    if (e?.name === "NotFoundError") { log("No device picked.", "warn"); setStatus("Idle"); }
    else { log(e.message || String(e), "err"); setStatus("Error", "err"); }
    await link?.disconnect();
    link = null;
  } finally { setBusy(false); }
}

async function sendAdmin(bytes) {
  await link.send(encodeAdminToRadio(bytes, state.myNodeNum, randomId()));
  await sleep(500);
}

async function write() {
  if (!link || !["add", "stale"].includes(state.mode)) return;
  const index = state.targetIndex;
  // Last-second safety check against what we read.
  const current = state.channels[index];
  if (state.mode === "add" && current && current.role !== Role.DISABLED) {
    log(`CH${index} is no longer empty. Aborting.`, "err");
    return;
  }
  setBusy(true);
  setStatus("Writing…", "busy");
  try {
    const channel = encodeChannel({
      index,
      role: Role.SECONDARY,
      settings: { name: CHANNEL.name, psk: CHANNEL.psk },
    });
    log(`Writing HackerComms to CH${index}…`);
    await sendAdmin(Admin.beginEdit());
    await sendAdmin(Admin.setChannel(channel));
    await sendAdmin(Admin.commitEdit());
    log("Write sent. Verifying…");
    await sleep(1000);
    await downloadConfig();
    const p = plan();
    state.mode = p.mode; state.targetIndex = p.index;
    renderSlots();
    if (p.mode === "present") {
      log(`Verified: HackerComms is on CH${p.index}. See you on the mesh.`, "ok");
      renderPlan();
      setStatus("Installed", "ok");
    } else {
      throw new Error("The radio didn't confirm the new channel. Reconnect and check, or add it manually.");
    }
  } catch (e) {
    log(e.message || String(e), "err");
    setStatus("Check the radio", "warn");
    if (/closed|lost|disconnect/i.test(String(e))) log("If the radio rebooted, reconnect to confirm the channel is there.", "warn");
  } finally { setBusy(false); }
}

function afterDisconnect() {
  link = null;
  ui.btnDisconnect.hidden = true;
  ui.btnWrite.hidden = true;
  setStatus("Disconnected");
}

ui.btnSerial.addEventListener("click", () => connect(SerialTransport));
ui.btnBle.addEventListener("click", () => connect(BleTransport));
ui.btnWrite.addEventListener("click", write);
ui.btnDisconnect.addEventListener("click", async () => { await link?.disconnect(); afterDisconnect(); log("Disconnected."); });

// ---------- capability hints ----------
if (!SerialTransport.supported()) { ui.btnSerial.dataset.locked = "1"; ui.btnSerial.disabled = true; ui.btnSerial.title = "Needs Chrome, Edge or Opera on desktop"; }
if (!BleTransport.supported()) { ui.btnBle.dataset.locked = "1"; ui.btnBle.disabled = true; ui.btnBle.title = "Needs Chrome or Edge with Web Bluetooth"; }
if (!SerialTransport.supported() && !BleTransport.supported()) {
  $("#unsupported").hidden = false;
}

// ---------- phone-app link (adds, doesn't replace) ----------
const setB64 = bytesToB64(encodeChannelSet([{ name: CHANNEL.name, psk: CHANNEL.psk }]), true);
export const addUrl = `https://meshtastic.org/e/?add=true#${setB64}`;
const urlEl = $("#add-url");
if (urlEl) { urlEl.href = addUrl; urlEl.textContent = addUrl; }
const qrEl = $("#qr");
if (qrEl && !window.qrcode) qrEl.hidden = true;
if (qrEl && window.qrcode) {
  const qr = window.qrcode(0, "M");
  qr.addData(addUrl);
  qr.make();
  qrEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

setStatus("Idle");
log("Ready. Plug in your radio by USB or pick Bluetooth.");
