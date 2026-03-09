import { create } from "zustand";
import { devtools } from "zustand/middleware";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface VoiceState {
	pipelineState: string;
	enabled: boolean;

	setPipelineState: (state: string) => void;
	setEnabled: (enabled: boolean) => void;
}

export const useVoiceStore = create<VoiceState>()(
	devtools(
		(set) => ({
			pipelineState: "idle",
			enabled: false,

			setPipelineState: (pipelineState) => set({ pipelineState }),
			setEnabled: (enabled) => set({ enabled }),
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
