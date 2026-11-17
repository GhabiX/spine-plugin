// Vite compiles an imported stylesheet to a string with `?inline`, so the
// bundle carries its own styles instead of emitting a file the web client
// would not load.
declare module "*.css?inline" {
  const css: string;
  export default css;
}
