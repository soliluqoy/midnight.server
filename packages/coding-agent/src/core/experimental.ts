export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.MIDNIGHT_SERVER_EXPERIMENTAL === "1";
}
