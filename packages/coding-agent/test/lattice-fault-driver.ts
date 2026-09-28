// Child-process driver for lattice-faults.test.ts: performs one operation on a store so that
// LATTICE_FAULT can kill the process at a named point inside it.
import { recordsFilterProgram } from "../src/lattice/contracts.ts";
import { Lattice } from "../src/lattice/kernel.ts";

const [dataDir, action, argument] = process.argv.slice(2);
const lattice = Lattice.open(dataDir);
switch (action) {
	case "promote": {
		const seed = lattice.store.head("records.filter")!.version.version_id;
		lattice.store.startCampaign({
			campaignId: "camp_fault",
			skillId: "records.filter",
			kind: "program",
			parentVersion: seed,
			record: {},
		});
		lattice.store.promote({
			skillId: "records.filter",
			expectedParent: seed,
			program: recordsFilterProgram(["is_log", "old_enough", "size_positive", "visible", "text_hit"]),
			campaignId: "camp_fault",
			report: {},
		});
		break;
	}
	case "artifact":
		lattice.store.putArtifact(Buffer.from(argument), "text/plain", "fault-test");
		break;
	case "snapshot":
		lattice.store.createSnapshot("policy");
		break;
	case "apply":
		lattice.applyPlan(argument);
		break;
	default:
		throw new Error(`unknown action ${action}`);
}
lattice.close();
