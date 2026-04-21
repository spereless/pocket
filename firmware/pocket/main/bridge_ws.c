#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/ringbuf.h"

#include "bridge_ws.h"
#include "secrets.h"

static const char *TAG = "bridge_ws";

static esp_websocket_client_handle_t client = NULL;
static RingbufHandle_t rx_ring = NULL;
static volatile int64_t last_rx_audio_us = 0;
static volatile bool connected = false;

static size_t rx_bytes = 0, tx_bytes = 0;
static int64_t last_report_us = 0;

static void ws_event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data)
{
    esp_websocket_event_data_t *ev = (esp_websocket_event_data_t *)event_data;
    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "connected to %s", POCKET_BRIDGE_URL);
        connected = true;
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
        ESP_LOGW(TAG, "disconnected");
        connected = false;
        break;
    case WEBSOCKET_EVENT_DATA: {
        if (ev->op_code == 0x2 && ev->data_len > 0) {   /* binary = PCM */
            rx_bytes += ev->data_len;
            last_rx_audio_us = esp_timer_get_time();
            if (rx_ring) {
                BaseType_t ok = xRingbufferSend(rx_ring, ev->data_ptr, ev->data_len, 0);
                if (ok != pdTRUE) {
                    ESP_LOGW(TAG, "rx ring full, dropped %d B", ev->data_len);
                }
            }
        } else if (ev->op_code == 0x1 && ev->data_len > 0) {   /* text = control */
            ESP_LOGI(TAG, "control: %.*s", ev->data_len, (const char *)ev->data_ptr);
        }
        int64_t now = esp_timer_get_time();
        if (now - last_report_us > 2000000) {
            ESP_LOGI(TAG, "rx=%u B  tx=%u B (cumulative, connected=%d)",
                     (unsigned)rx_bytes, (unsigned)tx_bytes, (int)connected);
            last_report_us = now;
        }
        break;
    }
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGE(TAG, "error event");
        break;
    default:
        break;
    }
}

esp_err_t bridge_ws_start(void)
{
    /* 512 KB ≈ 10 s of 48 kB/s audio — xAI bursts Grok's reply faster than
     * realtime; smaller rings were dropping the tail of long replies.
     * Allocated from PSRAM because internal SRAM is only ~277 KB. */
    rx_ring = xRingbufferCreateWithCaps(512 * 1024, RINGBUF_TYPE_BYTEBUF,
                                         MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!rx_ring) {
        ESP_LOGE(TAG, "ring alloc failed");
        return ESP_FAIL;
    }

    esp_websocket_client_config_t cfg = {
        .uri = POCKET_BRIDGE_URL,
        .reconnect_timeout_ms = 2000,
        .network_timeout_ms = 10000,
        .buffer_size = 4096,
        .ping_interval_sec = 10,        /* keepalive so we notice a dead bridge */
        .pingpong_timeout_sec = 20,     /* and reconnect within ~20 s of bridge death */
    };
    client = esp_websocket_client_init(&cfg);
    if (!client) {
        ESP_LOGE(TAG, "init failed");
        return ESP_FAIL;
    }
    esp_websocket_register_events(client, WEBSOCKET_EVENT_ANY, ws_event_handler, NULL);
    ESP_LOGI(TAG, "starting client -> %s", POCKET_BRIDGE_URL);
    return esp_websocket_client_start(client);
}

esp_err_t bridge_ws_send_pcm(const void *buf, size_t len)
{
    if (!connected || !client) return ESP_ERR_INVALID_STATE;
    int sent = esp_websocket_client_send_bin(client, (const char *)buf, len, pdMS_TO_TICKS(100));
    if (sent > 0) {
        tx_bytes += sent;
        return ESP_OK;
    }
    ESP_LOGW(TAG, "send_bin returned %d (len=%u)", sent, (unsigned)len);
    return ESP_FAIL;
}

esp_err_t bridge_ws_send_text(const char *text)
{
    if (!connected || !client || !text) return ESP_ERR_INVALID_STATE;
    int len = (int)strlen(text);
    int sent = esp_websocket_client_send_text(client, text, len, pdMS_TO_TICKS(100));
    if (sent > 0) return ESP_OK;
    ESP_LOGW(TAG, "send_text returned %d (len=%d)", sent, len);
    return ESP_FAIL;
}

size_t bridge_ws_receive_pcm(void *out, size_t max_len, TickType_t wait)
{
    if (!rx_ring) return 0;
    size_t got = 0;
    uint8_t *data = (uint8_t *)xRingbufferReceiveUpTo(rx_ring, &got, wait, max_len);
    if (!data) return 0;
    memcpy(out, data, got);
    vRingbufferReturnItem(rx_ring, data);
    return got;
}

int64_t bridge_ws_last_rx_audio_us(void) { return last_rx_audio_us; }

bool bridge_ws_connected(void) { return connected; }
