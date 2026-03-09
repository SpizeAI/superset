import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface TraceMetricsState {
	traceHits: number;
	traceMisses: number;
	guardFailures: number;
	traceErrors: number;
	claudeFallbacks: number;
	totalRequests: number;
}

interface VoiceState {
	pipelineState: string;
	enabled: boolean;
	traceKillSwitch: boolean;
	metrics: TraceMetricsState;

	setPipelineState: (state: string) => void;
	setEnabled: (enabled: boolean) => void;
	setTraceKillSwitch: (active: boolean) => void;
	setMetrics: (metrics: TraceMetricsState) => void;
}

export const useVoiceStore = create<VoiceState>()(
	devtools(
		(set) => ({
			pipelineState: "idle",
			enabled: false,
			traceKillSwitch: false,
			metrics: {
				traceHits: 0,
				traceMisses: 0,
				guardFailures: 0,
				traceErrors: 0,
				claudeFallbacks: 0,
				totalRequests: 0,
			},

			setPipelineState: (pipelineState) => set({ pipelineState }),
			setEnabled: (enabled) => set({ enabled }),
			setTraceKillSwitch: (traceKillSwitch) => set({ traceKillSwitch }),
			setMetrics: (metrics) => set({ metrics }),
		}),
		{ name: "VoiceStore" },
	),
);

/**
 * Hook to sync voice pipeline state from the main process via tRPC subscription.
 * Call this once in a top-level component.
 */
export function useVoiceSync() {
	const setPipelineState = useVoiceStore((state) => state.setPipelineState);

	electronTrpc.voice.status.useSubscription(undefined, {
		onData: (event) => {
			setPipelineState(event.state);
		},
	});
}

// Convenience hooks
export const useVoicePipelineState = () =>
	useVoiceStore((state) => state.pipelineState);
export const useIsVoiceEnabled = () =>
	useVoiceStore((state) => state.enabled);
export const useTraceMetrics = () =>
	useVoiceStore((state) => state.metrics);
export const useTraceKillSwitch = () =>
	useVoiceStore((state) => state.traceKillSwitch);
