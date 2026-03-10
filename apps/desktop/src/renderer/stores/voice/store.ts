import { useRef } from "react";
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
 *
 * Uses a stable options ref to prevent useSubscription from restarting
 * on every render (which would cause an infinite re-render loop since
 * the initial emit triggers a state update → re-render → new options → restart).
 */
export function useVoiceSync() {
	const setPipelineState = useVoiceStore((state) => state.setPipelineState);
	const optionsRef = useRef({
		onData: (event: { state: string }) => {
			setPipelineState(event.state);
		},
	});

	electronTrpc.voice.status.useSubscription(undefined, optionsRef.current);
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
