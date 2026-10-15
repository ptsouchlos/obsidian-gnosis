// esbuild's `binary` loader hands a `.wasm` import over as a `Uint8Array`.
declare module "*.wasm" {
    const bytes: Uint8Array;
    export default bytes;
}
