/**
 * Pan laws. Equal-power keeps stereo power flat but swells a centred,
 * correlated source +3.01 dB on a phone that folds to mono; linear is flat in
 * mono but dips -3.01 dB on headphones; -4.5 dB errs +-1.51 dB on both.
 * Decorrelated beds fold flat under equal-power (dlist/E26).
 */
export const PAN_LAWS = ['equal-power', 'linear', '-4.5dB'];

/** Law for an output device: 'headphones' | 'stereo' | 'mono' | 'unknown'. */
export function lawForDevice(device) {
  if (device === 'mono') return 'linear';
  if (device === 'unknown') return '-4.5dB';
  return 'equal-power';
}

/**
 * @param {number} pan -1 (left) .. +1 (right)
 * @param {string} law
 * @returns {[number, number]} [left gain, right gain]
 */
export function panGains(pan, law = 'equal-power') {
  const p = (Math.max(-1, Math.min(1, pan)) + 1) / 2;
  const th = (p * Math.PI) / 2;
  if (law === 'linear') return [1 - p, p];
  if (law === '-4.5dB') return [Math.sqrt((1 - p) * Math.cos(th)), Math.sqrt(p * Math.sin(th))];
  return [Math.cos(th), Math.sin(th)];
}
