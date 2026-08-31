export function deploymentBaseUrl(): URL {
  const configured =
    (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ||
    "./";
  return new URL(configured, document.baseURI);
}

export function deploymentAssetUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ""), deploymentBaseUrl()).href;
}
