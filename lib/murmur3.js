// murmurhash3 x64 128（纯 JS / BigInt 实现，零依赖）
// 用途：复刻智慧教学云前端的 fl-sec-sign 请求签名。
// 已用真实抓包向量验证：见 scripts/api.js 里的 --selftest。
const M64 = (1n << 64n) - 1n;
const C1 = 0x87c37b91114253d5n;
const C2 = 0x4cf5ad432745937fn;

function rotl(x, r) { r = BigInt(r); return ((x << r) | (x >> (64n - r))) & M64; }
function fmix(k) {
  k ^= k >> 33n; k = (k * 0xff51afd7ed558ccdn) & M64;
  k ^= k >> 33n; k = (k * 0xc4ceb9fe1a85ec53n) & M64;
  k ^= k >> 33n; return k;
}
function rd64(buf, off) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]);
  return v;
}

// 返回 128bit（两个 64bit 大整数）
function x64hash128(bytes, seed = 0) {
  let h1 = BigInt(seed), h2 = BigInt(seed);
  const nblocks = Math.floor(bytes.length / 16);
  for (let i = 0; i < nblocks; i++) {
    let k1 = rd64(bytes, i * 16), k2 = rd64(bytes, i * 16 + 8);
    k1 = (k1 * C1) & M64; k1 = rotl(k1, 31); k1 = (k1 * C2) & M64; h1 ^= k1;
    h1 = rotl(h1, 27); h1 = (h1 + h2) & M64; h1 = (h1 * 5n + 0x52dce729n) & M64;
    k2 = (k2 * C2) & M64; k2 = rotl(k2, 33); k2 = (k2 * C1) & M64; h2 ^= k2;
    h2 = rotl(h2, 31); h2 = (h2 + h1) & M64; h2 = (h2 * 5n + 0x38495ab5n) & M64;
  }
  const tail = bytes.slice(nblocks * 16);
  let k1 = 0n, k2 = 0n;
  for (let i = tail.length - 1; i >= 8; i--) k2 = (k2 << 8n) | BigInt(tail[i]);
  if (tail.length > 8) { k2 = (k2 * C2) & M64; k2 = rotl(k2, 33); k2 = (k2 * C1) & M64; h2 ^= k2; }
  for (let i = Math.min(tail.length, 8) - 1; i >= 0; i--) k1 = (k1 << 8n) | BigInt(tail[i]);
  if (tail.length > 0) { k1 = (k1 * C1) & M64; k1 = rotl(k1, 31); k1 = (k1 * C2) & M64; h1 ^= k1; }
  h1 ^= BigInt(bytes.length); h2 ^= BigInt(bytes.length);
  h1 = (h1 + h2) & M64; h2 = (h2 + h1) & M64;
  h1 = fmix(h1); h2 = fmix(h2);
  h1 = (h1 + h2) & M64; h2 = (h2 + h1) & M64;
  return [h1, h2];
}

function hex32(bytes) {
  const [a, b] = x64hash128(bytes);
  // 逐 32bit 段拼接：h1 高字、h1 低字、h2 高字、h2 低字
  // （顺序对着前端 x64.hash128 的真实输出校过，别凭直觉改）
  const h = n => ('00000000' + (n & 0xffffffffn).toString(16)).slice(-8);
  return h(a >> 32n) + h(a) + h(b >> 32n) + h(b);
}

export { x64hash128, hex32 };
export default { x64hash128, hex32 };
