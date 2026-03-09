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

export function VoiceSettings({ visibleItems }: VoiceSettingsProps) {
	const { data: config } = electronTrpc.voice.getConfig.useQuery();
	const { data: secrets } = electronTrpc.voice.hasSecrets.useQuery();
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
