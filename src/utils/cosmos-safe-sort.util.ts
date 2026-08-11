type DateLike = Date | string | undefined | null;

function toTime(value: DateLike): number {
    if (!value) {
        return 0;
    }
    return new Date(value).getTime();
}

export function sortByCreatedAtAsc<T extends { createdAt?: DateLike }>(
    items: T[],
): T[] {
    return [...items].sort(
        (a, b) => toTime(a.createdAt) - toTime(b.createdAt),
    );
}

export function sortByCreatedAtDesc<T extends { createdAt?: DateLike }>(
    items: T[],
): T[] {
    return [...items].sort(
        (a, b) => toTime(b.createdAt) - toTime(a.createdAt),
    );
}

export function sortByUpdatedAtDesc<T extends { updatedAt?: DateLike }>(
    items: T[],
): T[] {
    return [...items].sort(
        (a, b) => toTime(b.updatedAt) - toTime(a.updatedAt),
    );
}

export function sortByLastActiveAtDesc<T extends { lastActiveAt?: DateLike }>(
    items: T[],
): T[] {
    return [...items].sort(
        (a, b) => toTime(b.lastActiveAt) - toTime(a.lastActiveAt),
    );
}

export function sortCareSchedules<T extends { time?: string; title?: string }>(
    items: T[],
): T[] {
    return [...items].sort((a, b) => {
        const timeCmp = (a.time ?? "").localeCompare(b.time ?? "");
        if (timeCmp !== 0) {
            return timeCmp;
        }
        return (a.title ?? "").localeCompare(b.title ?? "");
    });
}
