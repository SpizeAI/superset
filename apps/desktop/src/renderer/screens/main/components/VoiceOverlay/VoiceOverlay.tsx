import { useState, useRef } from "react";
import { cn } from "@superset/ui/utils";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useVoicePipelineState, useVoiceSync } from "renderer/stores/voice/store";

const STATE_LABELS: Record<string, string> = {
	idle: "",
	"listening-for-wake": "Voice",
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
 * Includes a text input fallback for testing when mic is unavailable.
 */
export function VoiceOverlay() {
	useVoiceSync();
	const pipelineState = useVoicePipelineState();
	const [showInput, setShowInput] = useState(false);
	const [command, setCommand] = useState("");
	const [lastResponse, setLastResponse] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const sendCommand = electronTrpc.voice.sendCommand.useMutation();

	if (pipelineState === "idle") return null;

	const label = STATE_LABELS[pipelineState] ?? pipelineState;
	const color = STATE_COLORS[pipelineState] ?? "bg-muted/50";
	const isBusy = pipelineState === "thinking" || pipelineState === "speaking";

	const handleSubmit = async () => {
		const text = command.trim();
		if (!text || isBusy) return;
		setCommand("");
		setLastResponse(null);
		try {
			const result = await sendCommand.mutateAsync({ text });
			setLastResponse(result.response);
		} catch (error) {
			setLastResponse(
				`Error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	return (
		<div className="no-drag flex items-center gap-1.5 relative">
			<button
				type="button"
				onClick={() => {
					setShowInput(!showInput);
					if (!showInput) {
						setTimeout(() => inputRef.current?.focus(), 50);
					}
				}}
				className={cn(
					"flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs cursor-pointer",
					"text-muted-foreground transition-colors duration-200 hover:bg-muted",
					color,
				)}
			>
				<div
					className={cn(
						"w-1.5 h-1.5 rounded-full",
						pipelineState === "listening-for-command" ||
							pipelineState === "conversational"
							? "bg-blue-500 animate-pulse"
							: pipelineState === "speaking"
								? "bg-green-500"
								: pipelineState === "thinking"
									? "bg-purple-500 animate-pulse"
									: "bg-muted-foreground/50",
					)}
				/>
				<span>{isBusy ? label : label || "Voice"}</span>
			</button>

			{showInput && (
				<div className="absolute top-full right-0 mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg p-2 w-72">
					<form
						onSubmit={(e) => {
							e.preventDefault();
							handleSubmit();
						}}
					>
						<input
							ref={inputRef}
							type="text"
							value={command}
							onChange={(e) => setCommand(e.target.value)}
							placeholder={
								isBusy ? "Processing..." : "Type a voice command..."
							}
							disabled={isBusy}
							className="w-full bg-muted/50 border border-border rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
						/>
					</form>
					{lastResponse && (
						<div className="mt-2 text-xs text-muted-foreground bg-muted/30 rounded p-2 max-h-32 overflow-y-auto whitespace-pre-wrap">
							{lastResponse}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
