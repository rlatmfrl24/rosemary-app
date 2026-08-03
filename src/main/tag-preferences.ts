import type { DatabaseSync } from "node:sqlite";
import {
	getTagPreferenceKey,
	type TagPreference,
	type TagPreferenceIdentity,
	type TagPreferenceInput,
	type TagPreferenceKind,
} from "../shared/tag-preferences.ts";

interface TagPreferenceRow {
	tag_key: string;
	namespace: string;
	value: string;
	kind: TagPreferenceKind;
	created_at: string;
	updated_at: string;
}

const mapTagPreferenceRow = (row: TagPreferenceRow): TagPreference => ({
	key: row.tag_key,
	namespace: row.namespace,
	value: row.value,
	kind: row.kind,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
});

export const listTagPreferences = (database: DatabaseSync): TagPreference[] => {
	const rows = database
		.prepare(
			`SELECT tag_key, namespace, value, kind, created_at, updated_at
			 FROM user_tag_preferences
			 ORDER BY CASE kind WHEN 'preferred' THEN 0 ELSE 1 END,
			          namespace COLLATE NOCASE ASC,
			          value COLLATE NOCASE ASC`,
		)
		.all() as unknown as TagPreferenceRow[];

	return rows.map(mapTagPreferenceRow);
};

export const upsertTagPreference = (
	database: DatabaseSync,
	input: TagPreferenceInput,
	now = new Date().toISOString(),
): TagPreference => {
	const namespace = input.namespace.trim();
	const value = input.value.trim();
	if (
		!namespace ||
		!value ||
		(input.kind !== "preferred" && input.kind !== "excluded")
	) {
		throw new Error("저장할 태그 설정이 올바르지 않습니다.");
	}
	const key = getTagPreferenceKey({ namespace, value });
	if (!key) {
		throw new Error("저장할 태그 설정이 올바르지 않습니다.");
	}

	database
		.prepare(
			`INSERT INTO user_tag_preferences (
				tag_key, namespace, value, kind, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(tag_key) DO UPDATE SET
				namespace = excluded.namespace,
				value = excluded.value,
				kind = excluded.kind,
				updated_at = excluded.updated_at`,
		)
		.run(key, namespace, value, input.kind, now, now);

	const row = database
		.prepare(
			`SELECT tag_key, namespace, value, kind, created_at, updated_at
			 FROM user_tag_preferences WHERE tag_key = ?`,
		)
		.get(key) as TagPreferenceRow | undefined;
	if (!row) {
		throw new Error("태그 설정을 저장하지 못했습니다.");
	}

	return mapTagPreferenceRow(row);
};

export const deleteTagPreference = (
	database: DatabaseSync,
	input: TagPreferenceIdentity,
): void => {
	const key = getTagPreferenceKey(input);
	if (!key) {
		throw new Error("삭제할 태그 설정이 올바르지 않습니다.");
	}
	database
		.prepare("DELETE FROM user_tag_preferences WHERE tag_key = ?")
		.run(key);
};
