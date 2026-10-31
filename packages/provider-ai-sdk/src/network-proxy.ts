import { ProxyAgent } from "undici";
import { buildNetworkProxyUrl, shouldBypassNetworkProxyForUrl, type NetworkProxyRuntimeConfig } from "@buildwarden/shared";

const getRequestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
};

export const createProxyAwareFetch = (networkProxy: NetworkProxyRuntimeConfig | undefined): typeof fetch | undefined => {
  if (!networkProxy) {
    return undefined;
  }
  const proxyAgent = new ProxyAgent(buildNetworkProxyUrl(networkProxy));
  return (input, init) => {
    const url = getRequestUrl(input);
    if (shouldBypassNetworkProxyForUrl(url, networkProxy)) {
      return fetch(input, init);
    }
    return fetch(
      input,
      {
        ...(init ?? {}),
        dispatcher: proxyAgent,
      } as RequestInit & { dispatcher: ProxyAgent },
    );
  };
};

