/**
 * IEEE 754 half-precision conversion.
 *
 * `.kact` stores activations as float16 and everything in memory is float32, so
 * the codec converts on both edges. `Float16Array` is not yet available across
 * the runtimes katascope targets, and `DataView.getFloat16` is newer still, so
 * this does the bit twiddling itself.
 *
 * Half precision holds about 3.3 decimal digits and saturates at 65504. Trunk
 * activations sit comfortably inside that -- a b18c384 block ranges roughly
 * -30..17 -- but the encoder clamps rather than emitting Infinity, because a
 * heatmap with an infinite cell renders as a blank board rather than an error.
 */

/** Largest finite half-precision value. */
export const FLOAT16_MAX = 65504;

const scratch = new ArrayBuffer(4);
const floatView = new Float32Array(scratch);
const intView = new Int32Array(scratch);

/** Converts one float32 to the bit pattern of a float16, rounding to nearest even. */
export function toFloat16Bits(value: number): number {
  // NaN survives as NaN; infinities and anything past the half-precision range
  // clamp to the largest finite value.
  if (Number.isNaN(value)) return 0x7e00;
  if (value > FLOAT16_MAX) return 0x7bff;
  if (value < -FLOAT16_MAX) return 0xfbff;

  floatView[0] = value;
  const bits = intView[0] ?? 0;

  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x007f_ffff;

  // Underflow to zero: too small even for a subnormal half.
  if (exponent < 103) return sign;

  // Subnormal half: shift the implicit leading 1 back in and round.
  if (exponent < 113) {
    const shifted = mantissa | 0x0080_0000;
    const shift = 126 - exponent;
    const rounded = (shifted >>> shift) + ((shifted >>> (shift - 1)) & 1);
    return sign | rounded;
  }

  const halfExponent = exponent - 112;
  const halfMantissa = mantissa >>> 13;
  // Round half to even on the dropped bits.
  const remainder = mantissa & 0x1fff;
  let result = sign | (halfExponent << 10) | halfMantissa;
  if (remainder > 0x1000 || (remainder === 0x1000 && (halfMantissa & 1) === 1)) {
    result += 1;
  }
  return result & 0xffff;
}

/** Converts a float16 bit pattern back to a float32-representable number. */
export function fromFloat16Bits(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x03ff;

  if (exponent === 0) return sign * 2 ** -14 * (mantissa / 1024);
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
}

/** Encodes a float32 plane buffer as half-precision, little-endian. */
export function encodeFloat16Array(values: Float32Array): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) {
    view.setUint16(i * 2, toFloat16Bits(values[i] ?? 0), true);
  }
  return out;
}

/** Decodes half-precision little-endian bytes into a float32 array. */
export function decodeFloat16Array(bytes: Uint8Array, count: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = Math.fround(fromFloat16Bits(view.getUint16(i * 2, true)));
  }
  return out;
}
