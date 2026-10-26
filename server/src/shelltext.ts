// Pipe-fed Windows shells can't speak real UTF-8: cmd's pipe I/O is pinned
// to the OEM codepage (CP936 on zh-CN) and `chcp 65001` only affects console
// handles, not pipes. A spawned child (git/node/`type file`) may still emit
// UTF-8 — streams can genuinely mix. Strategy per chunk: hold back an
// incomplete trailing UTF-8 sequence, try a strict UTF-8 decode, fall back
// to GB18030. GBK bytes almost always break strict UTF-8; UTF-8 always
// passes — both producers come out right.

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const gbk = new TextDecoder("gb18030");

export class ShellDecoder {
  private carry: Buffer = Buffer.alloc(0);

  constructor(private readonly oem: boolean) {}

  push(chunk: Buffer): string {
    if (!this.oem) return chunk.toString("utf8");
    const b = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    // hold back ≤3 trailing bytes of an incomplete UTF-8 multibyte seq:
    // walk back over continuation bytes (0x80-0xBF), then check whether the
    // lead byte's expected length overshoots the buffer end.
    let head = b, tail: Buffer = Buffer.alloc(0);
    for (let i = b.length - 1; i >= Math.max(0, b.length - 4); i--) {
      const c = b[i];
      if (c < 0x80) break; // ASCII → no dangling seq
      if (c < 0xc0) continue; // continuation byte → keep walking back
      const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2;
      if (b.length - i < need) { head = b.subarray(0, i); tail = b.subarray(i); }
      break;
    }
    try {
      const s = utf8Strict.decode(head);
      this.carry = tail;
      return s;
    } catch {
      // strict UTF-8 failed → real GBK content. stream:true keeps a split
      // GBK pair inside the decoder for the next chunk.
      this.carry = Buffer.alloc(0);
      return gbk.decode(b, { stream: true });
    }
  }

  flush(): string {
    const rest = this.carry;
    this.carry = Buffer.alloc(0);
    if (!rest.length) return "";
    try { return utf8Strict.decode(rest); } catch { return gbk.decode(rest); }
  }
}
