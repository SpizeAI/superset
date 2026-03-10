import { useEffect, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@superset/ui/card";
import { Label } from "@superset/ui/label";
import { Switch } from "@superset/ui/switch";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface VoiceSettingsProps {
	visibleItems: string[] | null;
}

function isItemVisible(visibleItems: string[] | null, id: string): boolean {
	return visibleItems === null || visibleItems.includes(id);
}

function MicLevelMeter() {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const levelRef = useRef(0);
	const peakRef = useRef(0);
	const peakDecayRef = useRef(0);
	const animRef = useRef<number>(0);

	// Use IPC directly to avoid tRPC subscription re-render loop.
	// The preload exposes ipcRenderer on window (see preload/index.ts).
	useEffect(() => {
		const handler = (rms: number) => {
			if (rms <= 0) {
				levelRef.current = 0;
				return;
			}

			// Convert linear RMS to a dB-like scale so low speech levels are still visible.
			// Typical speech often lands around -45dB to -20dB on consumer USB mics.
			const db = 20 * Math.log10(rms / 32768);
			const normalized = Math.min(1, Math.max(0, (db + 60) / 50));
			levelRef.current = normalized;
		};
		(window as any).ipcRenderer?.on?.("voice:mic-level", handler);
		return () => {
			(window as any).ipcRenderer?.off?.("voice:mic-level", handler);
		};
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const draw = () => {
			const w = canvas.width;
			const h = canvas.height;
			const level = levelRef.current;

			// Peak hold with decay
			if (level > peakRef.current) {
				peakRef.current = level;
				peakDecayRef.current = 0;
			} else {
				peakDecayRef.current += 1;
				if (peakDecayRef.current > 30) {
					peakRef.current = Math.max(0, peakRef.current - 0.02);
				}
			}

			ctx.clearRect(0, 0, w, h);

			// Background track
			ctx.fillStyle = "hsl(var(--muted))";
			ctx.beginPath();
			ctx.roundRect(0, 0, w, h, 4);
			ctx.fill();

			// Level bar with color gradient
			const barWidth = level * w;
			if (barWidth > 0) {
				const gradient = ctx.createLinearGradient(0, 0, w, 0);
				gradient.addColorStop(0, "hsl(142, 76%, 44%)");     // green
				gradient.addColorStop(0.6, "hsl(142, 76%, 44%)");   // green
				gradient.addColorStop(0.8, "hsl(48, 96%, 53%)");    // yellow
				gradient.addColorStop(1, "hsl(0, 84%, 60%)");       // red
				ctx.fillStyle = gradient;
				ctx.beginPath();
				ctx.roundRect(0, 0, barWidth, h, 4);
				ctx.fill();
			}

			// Peak indicator line
			if (peakRef.current > 0.01) {
				const peakX = peakRef.current * w;
				ctx.fillStyle = "hsl(var(--foreground) / 0.5)";
				ctx.fillRect(peakX - 1, 0, 2, h);
			}

			animRef.current = requestAnimationFrame(draw);
		};

		draw();
		return () => cancelAnimationFrame(animRef.current);
	}, []);

	return (
		<canvas
			ref={canvasRef}
			width={300}
			height={12}
			className="w-full h-3 rounded"
		/>
	);
}

export function VoiceSettings({ visibleItems }: VoiceSettingsProps) {
	const { data: config } = electronTrpc.voice.getConfig.useQuery();
	const { data: secrets } = electronTrpc.voice.hasSecrets.useQuery();
	const { data: devices } = electronTrpc.voice.listAudioDevices.useQuery();
	const utils = electronTrpc.useUtils();
	const updateConfig = electronTrpc.voice.updateConfig.useMutation({
		onSuccess: () => utils.voice.getConfig.invalidate(),
	});
	const toggle = electronTrpc.voice.toggle.useMutation({
		onSuccess: () => utils.voice.getConfig.invalidate(),
	});

	if (!config) return null;

	return (
		<div className="flex flex-col gap-6 max-w-2xl">
			<div>
				<h1 className="text-lg font-semibold">Voice Control</h1>
				<p className="text-sm text-muted-foreground mt-1">
					Configure hands-free voice interaction with your workspaces.
				</p>
			</div>

			{isItemVisible(visibleItems, "voice-enabled") && (
				<Card>
					<CardHeader>
						<CardTitle className="text-sm">Voice Control</CardTitle>
						<CardDescription>
							Enable wake-word detection and voice commands.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="flex items-center justify-between">
							<Label htmlFor="voice-enabled">
								Enable Voice Control
							</Label>
							<Switch
								id="voice-enabled"
								checked={config.enabled}
								onCheckedChange={() => toggle.mutate()}
							/>
						</div>
					</CardContent>
				</Card>
			)}

			{isItemVisible(visibleItems, "voice-microphone") && (
				<Card>
					<CardHeader>
						<CardTitle className="text-sm">Microphone</CardTitle>
						<CardDescription>
							Select which input device to use for voice capture.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						<div className="flex items-center justify-between">
							<Label>Input Device</Label>
							<select
								className="bg-background border border-input rounded-md px-3 py-1 text-sm max-w-[240px] truncate"
								value={config.micDeviceIndex}
								onChange={(e) =>
									updateConfig.mutate({
										micDeviceIndex: Number(e.target.value),
									})
								}
							>
								<option value={-1}>System Default</option>
								{devices?.map((device) => (
									<option key={device.index} value={device.index}>
										{device.name}
									</option>
								))}
							</select>
						</div>
						{config.enabled && (
							<div className="flex flex-col gap-1.5">
								<Label className="text-xs text-muted-foreground">
									Input Level
								</Label>
								<MicLevelMeter />
								<p className="text-xs text-muted-foreground">
									Speak to verify the selected microphone is picking up audio.
								</p>
							</div>
						)}
					</CardContent>
				</Card>
			)}

			{isItemVisible(visibleItems, "voice-proactive") && (
				<Card>
					<CardHeader>
						<CardTitle className="text-sm">Proactive Alerts</CardTitle>
						<CardDescription>
							Speak notifications when agents complete tasks or need permission.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="flex items-center justify-between">
							<Label htmlFor="voice-proactive">
								Enable Proactive Alerts
							</Label>
							<Switch
								id="voice-proactive"
								checked={config.proactiveAlerts}
								onCheckedChange={(checked) =>
									updateConfig.mutate({ proactiveAlerts: checked })
								}
							/>
						</div>
					</CardContent>
				</Card>
			)}

			{isItemVisible(visibleItems, "voice-tts") && (
				<Card>
					<CardHeader>
						<CardTitle className="text-sm">Text-to-Speech</CardTitle>
						<CardDescription>
							Choose between ElevenLabs (higher quality) or macOS built-in.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						<div className="flex items-center justify-between">
							<Label>Provider</Label>
							<select
								className="bg-background border border-input rounded-md px-3 py-1 text-sm"
								value={config.ttsProvider}
								onChange={(e) =>
									updateConfig.mutate({
										ttsProvider: e.target.value as "elevenlabs" | "macos",
									})
								}
							>
								<option value="macos">macOS (Built-in)</option>
								<option value="elevenlabs">ElevenLabs</option>
							</select>
						</div>
						{config.ttsProvider === "elevenlabs" && (
							<p className="text-xs text-muted-foreground">
								{secrets?.hasElevenLabsKey
									? "ElevenLabs API key configured."
									: "ElevenLabs API key not set. Configure it below."}
							</p>
						)}
					</CardContent>
				</Card>
			)}

			{isItemVisible(visibleItems, "voice-sensitivity") && (
				<Card>
					<CardHeader>
						<CardTitle className="text-sm">Wake Word Sensitivity</CardTitle>
						<CardDescription>
							Adjust how easily the wake phrase is detected.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						<div className="flex items-center justify-between">
							<Label>Threshold</Label>
							<div className="flex items-center gap-2">
								<input
									type="range"
									min="0.1"
									max="0.9"
									step="0.05"
									value={config.wakeWordSensitivity}
									onChange={(e) =>
										updateConfig.mutate({
											wakeWordSensitivity: Number(e.target.value),
										})
									}
									className="w-32"
								/>
								<span className="text-sm text-muted-foreground w-10 text-right tabular-nums">
									{config.wakeWordSensitivity.toFixed(2)}
								</span>
							</div>
						</div>
						<p className="text-xs text-muted-foreground">
							For openWakeWord: lower values trigger more easily; higher values are stricter.
						</p>
					</CardContent>
				</Card>
			)}

			{isItemVisible(visibleItems, "voice-trace") && (
				<Card>
					<CardHeader>
						<CardTitle className="text-sm">Tool-Trace JIT</CardTitle>
						<CardDescription>
							Cache repeated voice commands for faster execution.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="flex items-center justify-between">
							<Label htmlFor="voice-trace">
								Enable Tool-Trace Cache
							</Label>
							<Switch
								id="voice-trace"
								checked={config.voiceTraceEnabled}
								onCheckedChange={(checked) =>
									updateConfig.mutate({ voiceTraceEnabled: checked })
								}
							/>
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
