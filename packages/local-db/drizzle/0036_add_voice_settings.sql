ALTER TABLE `settings` ADD `voice_enabled` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `voice_proactive_alerts` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `voice_tts_provider` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `voice_stt_mode` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `voice_whisper_model` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `voice_wake_word_sensitivity` real;--> statement-breakpoint
ALTER TABLE `settings` ADD `voice_conversation_timeout_ms` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `voice_command_timeout_ms` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `voice_trace_enabled` integer;
