import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@earendil-works/pi-ai/providers/radius-config";

export const RADIUS_PROVIDER_ID = "radius";
export const ENV_RADIUS_GATEWAY = "MIDNIGHT_SERVER_RADIUS_GATEWAY";

/** Radius gateway origin, honoring the `MIDNIGHT_SERVER_RADIUS_GATEWAY` override. */
export function getRadiusGatewayUrl(): string {
	return normalizeRadiusGatewayUrl(process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY);
}
