// transports.js — Web Serial and Web Bluetooth links to a Meshtastic radio.
// Both expose: connect(), send(Uint8Array), onFromRadio(cb), disconnect().

const START1 = 0x94, START2 = 0xc3;
const MAX_FRAME = 512;

export class SerialTransport {
  static supported() { return "serial" in navigator; }
  constructor() { this.port = null; this.reader = null; this.cb = () => {}; this.closing = false; this.onClose = () => {}; }
  onFromRadio(cb) { this.cb = cb; }

  async connect() {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: 115200 });
    this.writer = this.port.writable.getWriter();
    this.readLoop();
    // Wake the radio's API mode (same trick the official Python CLI uses).
    await this.writer.write(new Uint8Array(32).fill(START2));
    await new Promise((r) => setTimeout(r, 150));
  }

  async readLoop() {
    let buf = new Uint8Array(0);
    try {
      while (this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            const next = new Uint8Array(buf.length + value.length);
            next.set(buf); next.set(value, buf.length);
            buf = next;
            buf = this.drain(buf);
          }
        } finally { this.reader.releaseLock(); }
      }
    } catch (e) {
      if (!this.closing) this.onClose(e);
    }
  }

  // Pull complete 0x94 0xC3 <len_hi> <len_lo> <protobuf> frames out of the
  // buffer. Anything else on the wire is the radio's debug log — skip it.
  drain(buf) {
    for (;;) {
      const s = buf.indexOf(START1);
      if (s < 0) return new Uint8Array(0);
      if (s > 0) buf = buf.slice(s);
      if (buf.length < 4) return buf;
      if (buf[1] !== START2) { buf = buf.slice(1); continue; }
      const len = (buf[2] << 8) | buf[3];
      if (len > MAX_FRAME) { buf = buf.slice(1); continue; }
      if (buf.length < 4 + len) return buf;
      const frame = buf.slice(4, 4 + len);
      buf = buf.slice(4 + len);
      try { this.cb(frame); } catch (e) { console.warn("frame handler", e); }
    }
  }

  async send(payload) {
    const out = new Uint8Array(4 + payload.length);
    out[0] = START1; out[1] = START2;
    out[2] = (payload.length >> 8) & 0xff; out[3] = payload.length & 0xff;
    out.set(payload, 4);
    await this.writer.write(out);
  }

  async disconnect() {
    this.closing = true;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
  }
}

export class BleTransport {
  static SERVICE = "6ba1b218-15a8-461f-9fa8-5dcae273eafd";
  static TO_RADIO = "f75c76d2-129e-4dad-a1dd-7866124401e7";
  static FROM_RADIO = "2c55e69e-4993-11ed-b878-0242ac120002";
  static FROM_NUM = "ed9da18c-a800-4f66-a670-aa7547e34453";

  static supported() { return "bluetooth" in navigator; }
  constructor() { this.cb = () => {}; this.reading = false; this.again = false; this.onClose = () => {}; }
  onFromRadio(cb) { this.cb = cb; }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BleTransport.SERVICE] }],
    });
    this.device.addEventListener("gattserverdisconnected", () => this.onClose());
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(BleTransport.SERVICE);
    this.toRadio = await svc.getCharacteristic(BleTransport.TO_RADIO);
    this.fromRadio = await svc.getCharacteristic(BleTransport.FROM_RADIO);
    this.fromNum = await svc.getCharacteristic(BleTransport.FROM_NUM);
    await this.fromNum.startNotifications();
    this.fromNum.addEventListener("characteristicvaluechanged", () => this.pump());
  }

  // Read fromRadio until the radio hands back an empty value.
  async pump() {
    if (this.reading) { this.again = true; return; }
    this.reading = true;
    try {
      do {
        this.again = false;
        for (;;) {
          const v = await this.fromRadio.readValue();
          if (!v.byteLength) break;
          try { this.cb(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength))); }
          catch (e) { console.warn("frame handler", e); }
        }
      } while (this.again);
    } finally { this.reading = false; }
  }

  async send(payload) {
    await this.toRadio.writeValue(payload);
    // BLE has no stream: poll for the reply right after each write.
    await this.pump();
  }

  async disconnect() {
    try { this.device?.gatt?.disconnect(); } catch {}
  }
}
