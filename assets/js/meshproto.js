// meshproto.js — tiny, dependency-free protobuf codec for the handful of
// Meshtastic messages the HackerComms flasher needs. Field numbers come from
// the official meshtastic/protobufs definitions (mesh.proto, channel.proto,
// admin.proto, portnums.proto).

// ---------- low-level writer ----------
class Writer {
  constructor() { this.buf = []; }
  varint(v) {
    // supports values up to 2^53 safely
    v = Number(v);
    while (v > 0x7f) { this.buf.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    this.buf.push(v & 0x7f);
    return this;
  }
  tag(field, wireType) { return this.varint(field * 8 + wireType); }
  uint(field, v) { if (v) this.tag(field, 0).varint(v); return this; }
  bool(field, v) { if (v) this.tag(field, 0).varint(1); return this; }
  fixed32(field, v) {
    if (!v) return this;
    this.tag(field, 5);
    v = v >>> 0;
    this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  bytes(field, u8) {
    this.tag(field, 2).varint(u8.length);
    for (const b of u8) this.buf.push(b);
    return this;
  }
  string(field, s) { if (s) this.bytes(field, new TextEncoder().encode(s)); return this; }
  message(field, u8) { return this.bytes(field, u8); }
  finish() { return Uint8Array.from(this.buf); }
}

// ---------- low-level reader ----------
// Returns Map<fieldNumber, Array<value>> where value is a number (varint /
// fixed) or a Uint8Array (length-delimited).
function parse(u8) {
  const out = new Map();
  let i = 0;
  const readVarint = () => {
    let result = 0, mul = 1, b;
    do {
      if (i >= u8.length) throw new Error("truncated varint");
      b = u8[i++];
      result += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return result;
  };
  while (i < u8.length) {
    const key = readVarint();
    const field = Math.floor(key / 8), wt = key & 7;
    let val;
    if (wt === 0) val = readVarint();
    else if (wt === 1) { val = u8.slice(i, i + 8); i += 8; }
    else if (wt === 2) { const len = readVarint(); val = u8.slice(i, i + len); i += len; }
    else if (wt === 5) { val = (u8[i] | (u8[i + 1] << 8) | (u8[i + 2] << 16) | (u8[i + 3] << 24)) >>> 0; i += 4; }
    else throw new Error("unsupported wire type " + wt);
    if (!out.has(field)) out.set(field, []);
    out.get(field).push(val);
  }
  return out;
}
const first = (m, f, d) => (m.has(f) ? m.get(f)[0] : d);
const str = (u8) => (u8 ? new TextDecoder().decode(u8) : "");

// ---------- Meshtastic constants ----------
export const Role = { DISABLED: 0, PRIMARY: 1, SECONDARY: 2 };
export const ADMIN_APP = 6;
export const MAX_CHANNELS = 8;

// ---------- encoders ----------
// channel.proto: ChannelSettings { psk=2 bytes, name=3 string, uplink=5, downlink=6 }
export function encodeChannelSettings({ psk, name, uplink = false, downlink = false }) {
  return new Writer().bytes(2, psk).string(3, name).bool(5, uplink).bool(6, downlink).finish();
}
// channel.proto: Channel { index=1 int32, settings=2, role=3 enum }
export function encodeChannel({ index, role, settings }) {
  const w = new Writer().uint(1, index);
  if (settings) w.message(2, encodeChannelSettings(settings));
  return w.uint(3, role).finish();
}
// admin.proto: set_channel=33, begin_edit_settings=64, commit_edit_settings=65
export const Admin = {
  setChannel: (channelBytes) => new Writer().message(33, channelBytes).finish(),
  beginEdit: () => new Writer().bool(64, true).finish(),
  commitEdit: () => new Writer().bool(65, true).finish(),
};
// mesh.proto: Data { portnum=1, payload=2, want_response=3 }
// mesh.proto: MeshPacket { from=1 fixed32, to=2 fixed32, channel=3, decoded=4, id=6 fixed32, want_ack=10 }
// mesh.proto: ToRadio { packet=1, want_config_id=3 }
export function encodeAdminToRadio(adminBytes, myNodeNum, packetId) {
  const data = new Writer().uint(1, ADMIN_APP).bytes(2, adminBytes).bool(3, true).finish();
  const pkt = new Writer()
    .fixed32(1, myNodeNum)
    .fixed32(2, myNodeNum)
    .message(4, data)
    .fixed32(6, packetId)
    .bool(10, true)
    .finish();
  return new Writer().message(1, pkt).finish();
}
export function encodeWantConfig(configId) {
  return new Writer().tag(3, 0).varint(configId).finish();
}
// apponly.proto: ChannelSet { settings=1 repeated ChannelSettings }
export function encodeChannelSet(settingsList) {
  const w = new Writer();
  for (const s of settingsList) w.message(1, encodeChannelSettings(s));
  return w.finish();
}

// ---------- decoders ----------
function decodeChannel(u8) {
  const m = parse(u8);
  const s = m.has(2) ? parse(first(m, 2)) : new Map();
  return {
    index: first(m, 1, 0),
    role: first(m, 3, 0),
    name: str(first(s, 3)),
    psk: first(s, 2, new Uint8Array()),
  };
}
// FromRadio { packet=2, my_info=3, node_info=4, config=5, config_complete_id=7,
//             rebooted=8, channel=10, metadata=13, lockdown_status=18 }
export function decodeFromRadio(u8) {
  const m = parse(u8);
  if (m.has(10)) return { type: "channel", channel: decodeChannel(first(m, 10)) };
  if (m.has(3)) return { type: "myInfo", myNodeNum: first(parse(first(m, 3)), 1, 0) };
  if (m.has(7)) return { type: "configComplete", id: first(m, 7) };
  if (m.has(8)) return { type: "rebooted" };
  if (m.has(13)) {
    const md = parse(first(m, 13));
    return { type: "metadata", firmware: str(first(md, 1)) };
  }
  if (m.has(18)) {
    const ls = parse(first(m, 18));
    return { type: "lockdown", state: first(ls, 1, 0) };
  }
  if (m.has(4)) {
    const ni = parse(first(m, 4));
    const num = first(ni, 1, 0);
    const user = ni.has(2) ? parse(first(ni, 2)) : new Map();
    return { type: "nodeInfo", num, longName: str(first(user, 2)), shortName: str(first(user, 3)) };
  }
  if (m.has(2)) return { type: "packet" };
  return { type: "other" };
}

// ---------- helpers ----------
export function b64ToBytes(b64) {
  const bin = atob(b64.trim());
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
export function bytesToB64(u8, url = false) {
  let s = btoa(String.fromCharCode(...u8));
  if (url) s = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return s;
}
export function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export function randomId() {
  return crypto.getRandomValues(new Uint32Array(1))[0] >>> 0 || 1;
}
