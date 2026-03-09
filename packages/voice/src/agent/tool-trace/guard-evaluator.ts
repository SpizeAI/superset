import type { CompiledToolTrace, GuardContext, GuardResult } from "./types";
import { GUARDS } from "./guards";

/**
 * Evaluates all guards for a compiled trace.
 *
 * Guards are evaluated in order. The first failure short-circuits
 * and returns the failing guard's result. All guards must pass
 * for the trace to be eligible for execution.
 */
export class GuardEvaluator {
	evaluate(trace: CompiledToolTrace, context: GuardContext): GuardResult {
		for (const guardName of trace.guards) {
			const guardFn = GUARDS[guardName];
			if (!guardFn) {
				return {
					ok: false,
					failedGuard: guardName,
					reason: `Unknown guard: ${guardName}`,
				};
			}

			const result = guardFn(context);
			if (!result.ok) {
				return result;
			}
		}

		return { ok: true };
	}
}
