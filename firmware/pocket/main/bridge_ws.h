#pragma once

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "freertos/FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Connect to the bridge WebSocket (URL from secrets.h). Non-blocking; events
 * drive the lifecycle and auto-reconnect. Call once at boot, after Wi-Fi is up. */
esp_err_t bridge_ws_start(void);

/* Uplink PCM16 mono @ 24 kHz to the bridge. No-op if not connected. */
esp_err_t bridge_ws_send_pcm(const void *buf, size_t len);

/* Send a text (JSON) control frame to the bridge. No-op if not connected. */
esp_err_t bridge_ws_send_text(const char *text);

/* Drain downlinked PCM into the caller-provided buffer. Returns bytes copied.
 * Blocks up to `wait` ticks waiting for data. */
size_t    bridge_ws_receive_pcm(void *out, size_t max_len, TickType_t wait);

/* Timestamp (esp_timer_get_time) of the last downlinked PCM frame. Used by
 * the mic task as a cheap echo gate. */
int64_t   bridge_ws_last_rx_audio_us(void);

bool      bridge_ws_connected(void);

#ifdef __cplusplus
}
#endif
