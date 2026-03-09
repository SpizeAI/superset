import { cn } from "@superset/ui/utils";
import { useVoicePipelineState, useVoiceSync } from "renderer/stores/voice/store";

const STATE_LABELS: Record<string, string> = {
	idle: "",
	"listening-for-wake": "Listening...",
	"listening-for-command": "Speak now",
	conversational: "Listening...",
	transcribing: "Processing...",
	thinking: "Thinking...",
	speaking: "Speaking...",
};

const STATE_COLORS: Record<string, string> = {
	idle: "bg-transparent",
	"listening-for-wake": "bg-muted/50",
	"listening-for-command": "bg-blue-500/20",
	conversational: "bg-blue-500/20",
	transcribing: "bg-yellow-500/20",
	thinking: "bg-purple-500/20",
	speaking: "bg-green-500/20",
};

/**
 * Minimal voice state overlay shown in the top bar area.
 * Displays the current pipeline state as a compact indicator.
 */
export function VoiceOverlay() {
	useVoiceSync();
	const pipelineState = useVoicePipelineState();

	if (pipelineState === "idle") return null;

	const label = STATE_LABELS[pipelineState] ?? pipelineState;
	const color = STATE_COLORS[pipelineState] ?? "bg-muted/50";

	return (
		<div
			className={cn(
				"flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs",
				"text-muted-foreground transition-colors duration-200",
				color,
			)}
		>
			<div
				className={cn(
					"w-1.5 h-1.5 rounded-full",
					pipelineState === "listening-for-command" || pipelineState === "conversational"
						? "bg-blue-500 animate-pulse"
						: pipelineState === "speaking"
							? "bg-green-500"
							: "bg-muted-foreground/50",
				)}
			/>
			<span>{label}</span>
		</div>
	);
}
