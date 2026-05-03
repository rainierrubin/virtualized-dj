declare module "fft.js" {
  export default class FFT {
    constructor(size: number);
    size: number;
    /**
     * Convert real-valued input to interleaved complex form.
     */
    toComplexArray(input: number[] | Float32Array, output: Float32Array | null): Float32Array;
    /**
     * Forward FFT in-place on an interleaved complex array.
     */
    transform(output: Float32Array, input: Float32Array): void;
    /** Inverse FFT (not used here). */
    inverseTransform(output: Float32Array, input: Float32Array): void;
    /** Real-valued forward FFT — output is interleaved complex. */
    realTransform(output: Float32Array, input: Float32Array | number[]): void;
    completeSpectrum(spectrum: Float32Array): void;
  }
}
