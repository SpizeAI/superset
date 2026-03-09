import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useSettingsSearchQuery } from "renderer/stores/settings-state";
import { getMatchingItemsForSection } from "../utils/settings-search/settings-search";
import { VoiceSettings } from "./components/VoiceSettings";

export const Route = createFileRoute("/_authenticated/settings/voice/")({
	component: VoiceSettingsPage,
});

function VoiceSettingsPage() {
	const searchQuery = useSettingsSearchQuery();
	const visibleItems = useMemo(() => {
		if (!searchQuery) return null;
		return getMatchingItemsForSection(searchQuery, "voice").map(
			(item) => item.id,
		);
	}, [searchQuery]);

	return <VoiceSettings visibleItems={visibleItems} />;
}
