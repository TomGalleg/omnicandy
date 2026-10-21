declare module '*.png' {
  const url: string;
  export default url;
}

/** Only the Vite flag the renderer reads (tsconfig.web.json deliberately loads no ambient types). */
interface ImportMeta {
  readonly env: { readonly DEV: boolean };
}
