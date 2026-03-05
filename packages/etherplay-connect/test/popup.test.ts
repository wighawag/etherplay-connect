import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {createPopupLauncher} from '../src/popup.js';

describe('createPopupLauncher', () => {
	let originalOpen: typeof window.open;
	let mockPopup: {closed: boolean; close: () => void};
	let messageListeners: Set<(event: MessageEvent) => void>;
	let originalAddEventListener: typeof window.addEventListener;
	let originalRemoveEventListener: typeof window.removeEventListener;

	beforeEach(() => {
		originalOpen = window.open;
		originalAddEventListener = window.addEventListener;
		originalRemoveEventListener = window.removeEventListener;
		messageListeners = new Set();

		mockPopup = {
			closed: false,
			close: vi.fn(),
		};

		// Mock window.open
		(window as any).open = vi.fn(() => mockPopup as Window);

		// Mock addEventListener and removeEventListener for message events
		(window as any).addEventListener = vi.fn((type: string, handler: EventListenerOrEventListenerObject) => {
			if (type === 'message') {
				messageListeners.add(handler as (event: MessageEvent) => void);
			} else {
				originalAddEventListener.call(window, type, handler);
			}
		});

		(window as any).removeEventListener = vi.fn((type: string, handler: EventListenerOrEventListenerObject) => {
			if (type === 'message') {
				messageListeners.delete(handler as (event: MessageEvent) => void);
			} else {
				originalRemoveEventListener.call(window, type, handler);
			}
		});
	});

	afterEach(() => {
		(window as any).open = originalOpen;
		(window as any).addEventListener = originalAddEventListener;
		(window as any).removeEventListener = originalRemoveEventListener;
		vi.clearAllMocks();
	});

	it('should create a popup launcher', () => {
		const launcher = createPopupLauncher();
		expect(launcher).toBeDefined();
		expect(launcher.launchPopup).toBeDefined();
		expect(typeof launcher.launchPopup).toBe('function');
	});

	it('should launch a popup and return a promise with store capabilities', () => {
		const launcher = createPopupLauncher<{address: string}>();
		const url = 'https://example.com/login?param=value';

		const popupPromise = launcher.launchPopup(url);

		// Verify it's both a promise and has subscribe method
		expect(popupPromise).toBeInstanceOf(Promise);
		expect(typeof popupPromise.subscribe).toBe('function');
		expect(typeof popupPromise.cancel).toBe('function');

		// Verify window.open was called with correct parameters
		expect(window.open).toHaveBeenCalledTimes(1);
		const openCall = (window.open as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(openCall[0]).toContain('https://example.com/login');
		expect(openCall[0]).toContain('param=value');
		expect(openCall[0]).toContain('origin=');
		expect(openCall[0]).toContain('id=');
	});

	it('should resolve when receiving a successful message', async () => {
		const launcher = createPopupLauncher<{address: string}>();
		const url = 'https://example.com/login';

		const popupPromise = launcher.launchPopup(url);

		// Get the id from the URL
		const urlParams = new URL((window.open as ReturnType<typeof vi.fn>).mock.calls[0][0]);
		const id = parseInt(urlParams.searchParams.get('id') || '0');

		// Simulate receiving a message from the popup
		const messageEvent = new MessageEvent('message', {
			origin: 'https://example.com',
			data: {id, result: {address: '0x1234'}},
		});

		// Dispatch the message to all listeners
		messageListeners.forEach((listener) => listener(messageEvent));

		const result = await popupPromise;
		expect(result).toEqual({address: '0x1234'});
	});

	it('should reject when receiving an error message', async () => {
		const launcher = createPopupLauncher<{address: string}>();
		const url = 'https://example.com/login';

		const popupPromise = launcher.launchPopup(url);

		// Get the id from the URL
		const urlParams = new URL((window.open as ReturnType<typeof vi.fn>).mock.calls[0][0]);
		const id = parseInt(urlParams.searchParams.get('id') || '0');

		// Simulate receiving an error message from the popup
		const messageEvent = new MessageEvent('message', {
			origin: 'https://example.com',
			data: {id, error: {message: 'Authentication failed'}},
		});

		// Dispatch the message to all listeners
		messageListeners.forEach((listener) => listener(messageEvent));

		await expect(popupPromise).rejects.toEqual({message: 'Authentication failed'});
	});

	it('should ignore messages from different origins', async () => {
		const launcher = createPopupLauncher<{address: string}>();
		const url = 'https://example.com/login';

		const popupPromise = launcher.launchPopup(url);

		// Get the id from the URL
		const urlParams = new URL((window.open as ReturnType<typeof vi.fn>).mock.calls[0][0]);
		const id = parseInt(urlParams.searchParams.get('id') || '0');

		// Simulate receiving a message from a different origin
		const wrongOriginMessage = new MessageEvent('message', {
			origin: 'https://malicious.com',
			data: {id, result: {address: '0xhacked'}},
		});

		// Dispatch the message to all listeners
		messageListeners.forEach((listener) => listener(wrongOriginMessage));

		// The promise should not be resolved yet - we need a timeout to verify
		const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('timeout'), 50));
		const result = await Promise.race([popupPromise, timeoutPromise]);
		expect(result).toBe('timeout');
	});

	it('should ignore messages with different ids', async () => {
		const launcher = createPopupLauncher<{address: string}>();
		const url = 'https://example.com/login';

		const popupPromise = launcher.launchPopup(url);

		// Simulate receiving a message with a wrong id
		const wrongIdMessage = new MessageEvent('message', {
			origin: 'https://example.com',
			data: {id: 999999, result: {address: '0xwrong'}},
		});

		// Dispatch the message to all listeners
		messageListeners.forEach((listener) => listener(wrongIdMessage));

		// The promise should not be resolved yet
		const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('timeout'), 50));
		const result = await Promise.race([popupPromise, timeoutPromise]);
		expect(result).toBe('timeout');
	});

	it('should close existing popup when launching a new one', async () => {
		const launcher = createPopupLauncher<{address: string}>();
		const url = 'https://example.com/login';

		// Launch first popup
		const firstPopupPromise = launcher.launchPopup(url);

		const firstMockPopup = mockPopup;
		const firstCloseFunction = firstMockPopup.close;

		// Create a new mock popup for the second launch
		mockPopup = {
			closed: false,
			close: vi.fn(),
		};
		(window as any).open = vi.fn(() => mockPopup as Window);

		// Launch second popup - this will close and reject the first one
		launcher.launchPopup(url);

		// First popup should have been closed
		expect(firstCloseFunction).toHaveBeenCalled();

		// Handle the rejection from the first popup being closed
		await expect(firstPopupPromise).rejects.toEqual({message: 'popup closed so new one can take over'});
	});

	it('should track popup state through store subscription', async () => {
		const launcher = createPopupLauncher<{address: string}>();
		const url = 'https://example.com/login';

		const popupPromise = launcher.launchPopup(url);

		const states: {launched: boolean; closed: boolean; resolved: boolean}[] = [];
		const unsubscribe = popupPromise.subscribe((state) => {
			states.push({...state});
		});

		// Initial state should be launched=false
		expect(states[0].launched).toBe(false);
		expect(states[0].closed).toBe(false);
		expect(states[0].resolved).toBe(false);

		// Get the id and resolve the popup
		const urlParams = new URL((window.open as ReturnType<typeof vi.fn>).mock.calls[0][0]);
		const id = parseInt(urlParams.searchParams.get('id') || '0');

		const messageEvent = new MessageEvent('message', {
			origin: 'https://example.com',
			data: {id, result: {address: '0x1234'}},
		});

		messageListeners.forEach((listener) => listener(messageEvent));

		await popupPromise;

		// Final state should show resolved
		const finalState = states[states.length - 1];
		expect(finalState.closed).toBe(true);
		expect(finalState.resolved).toBe(true);

		unsubscribe();
	});

	it('should reject when popup fails to open', async () => {
		(window as any).open = vi.fn(() => null);

		const launcher = createPopupLauncher<{address: string}>();
		const url = 'https://example.com/login';

		// The error is thrown synchronously during promise creation, causing rejection
		await expect(launcher.launchPopup(url)).rejects.toThrow('could not open the login popup');
	});

	it('should support fullWindow option', () => {
		const launcher = createPopupLauncher<{address: string}>();
		const url = 'https://example.com/login';

		launcher.launchPopup(url, {fullWindow: true});

		// Verify window.open was called with empty parameters for full window
		const openCall = (window.open as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(openCall[2]).toBe('');
	});

	it('should use popup parameters by default', () => {
		const launcher = createPopupLauncher<{address: string}>();
		const url = 'https://example.com/login';

		launcher.launchPopup(url);

		// Verify window.open was called with popup parameters
		const openCall = (window.open as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(openCall[2]).toContain('popup=1');
		expect(openCall[2]).toContain('width=500');
		expect(openCall[2]).toContain('height=700');
	});
});
