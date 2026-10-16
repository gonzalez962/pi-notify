let lastBellTime = 0;
const BELL_DEBOUNCE_MS = 500;

export function ringBell(
	now: number = Date.now(),
	writer: (str: string) => void = (str) => {
		try {
			process.stdout.write(str);
		} catch {
			// Ignore write error
		}
	},
	isTTY: boolean = Boolean(process.stdout.isTTY),
): boolean {
	if (!isTTY) {
		return false;
	}

	if (now - lastBellTime < BELL_DEBOUNCE_MS) {
		return false;
	}

	lastBellTime = now;
	writer("\x07");
	return true;
}

export function resetBellState(): void {
	lastBellTime = 0;
}
