import type { GallerySourceTag } from "./gallery-metadata.ts";

export type TagPreferenceKind = "preferred" | "excluded";

export interface TagPreferenceIdentity {
	namespace: string;
	value: string;
}

export interface TagPreferenceInput extends TagPreferenceIdentity {
	kind: TagPreferenceKind;
}

export interface TagPreference extends TagPreferenceInput {
	key: string;
	createdAt: string;
	updatedAt: string;
}

const normalizeTagPreferencePart = (value: string): string =>
	value.trim().toLocaleLowerCase("en-US");

export const getTagPreferenceKey = (
	tag: TagPreferenceIdentity,
): string | null => {
	const namespace = normalizeTagPreferencePart(tag.namespace);
	const value = normalizeTagPreferencePart(tag.value);
	if (!namespace || !value) {
		return null;
	}

	return JSON.stringify([namespace, value]);
};

export const getMatchingTagPreferences = (
	tags: GallerySourceTag[],
	preferences: TagPreferenceIdentity[],
): TagPreferenceIdentity[] => {
	const preferencesByKey = new Map(
		preferences
			.map(
				(preference) => [getTagPreferenceKey(preference), preference] as const,
			)
			.filter(
				(entry): entry is [string, TagPreferenceIdentity] => entry[0] !== null,
			),
	);
	const matches = new Map<string, TagPreferenceIdentity>();

	for (const tag of tags) {
		const key = getTagPreferenceKey(tag);
		const preference = key ? preferencesByKey.get(key) : undefined;
		if (key && preference) {
			matches.set(key, preference);
		}
	}

	return [...matches.values()];
};

export const matchesAnyTagPreference = (
	tags: GallerySourceTag[],
	preferences: TagPreferenceIdentity[],
): boolean => getMatchingTagPreferences(tags, preferences).length > 0;

export const countMatchingTagPreferences = (
	tags: GallerySourceTag[],
	preferences: TagPreferenceIdentity[],
): number => getMatchingTagPreferences(tags, preferences).length;
