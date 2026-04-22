/*
 * SPDX-FileCopyrightText: 2021-2022 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: CC0-1.0
 */

#include <stdio.h>
#include <string.h>
#include "sdkconfig.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/i2s_std.h"
#include "esp_system.h"
#include "esp_check.h"
#include "es8311.h"
#include "example_config.h"
#include "driver/gpio.h"
#include "wifi.h"

static const char *TAG = "i2s_es8311";
static i2s_chan_handle_t tx_handle = NULL;
static i2s_chan_handle_t rx_handle = NULL;

/* Import music file as buffer */
#if CONFIG_EXAMPLE_MODE_MUSIC
extern const uint8_t music_pcm_start[] asm("_binary_canon_pcm_start");
extern const uint8_t music_pcm_end[]   asm("_binary_canon_pcm_end");
#endif

static void gpio_init(void)
{
    gpio_config_t io_conf = {};
    io_conf.intr_type = GPIO_INTR_DISABLE;      // 禁用中断
    io_conf.mode = GPIO_MODE_OUTPUT;           // 设置为输出模式
    io_conf.pin_bit_mask = (1ULL << GPIO_OUTPUT_PA); // 配置目标引脚
    io_conf.pull_down_en = 0;                  // 禁用下拉
    io_conf.pull_up_en = 0;                    // 禁用上拉
    gpio_config(&io_conf);                     // 应用配置

    // 设置 GPIO 输出高电平
    gpio_set_level(GPIO_OUTPUT_PA, 1);
}

static esp_err_t es8311_codec_init(void)
{
    /* Initialize I2C peripheral */
#if !defined(CONFIG_EXAMPLE_BSP)
    const i2c_config_t es_i2c_cfg = {
        .sda_io_num = I2C_SDA_IO,
        .scl_io_num = I2C_SCL_IO,
        .mode = I2C_MODE_MASTER,
        .sda_pullup_en = GPIO_PULLUP_ENABLE,
        .scl_pullup_en = GPIO_PULLUP_ENABLE,
        .master.clk_speed = 100000,
    };
    ESP_RETURN_ON_ERROR(i2c_param_config(I2C_NUM, &es_i2c_cfg), TAG, "config i2c failed");
    ESP_RETURN_ON_ERROR(i2c_driver_install(I2C_NUM, I2C_MODE_MASTER,  0, 0, 0), TAG, "install i2c driver failed");
#else
    ESP_ERROR_CHECK(bsp_i2c_init());
#endif

    /* Initialize es8311 codec */
    es8311_handle_t es_handle = es8311_create(I2C_NUM, ES8311_ADDRRES_0);
    ESP_RETURN_ON_FALSE(es_handle, ESP_FAIL, TAG, "es8311 create failed");
    const es8311_clock_config_t es_clk = {
        .mclk_inverted = false,
        .sclk_inverted = false,
        .mclk_from_mclk_pin = true,
        .mclk_frequency = EXAMPLE_MCLK_FREQ_HZ,
        .sample_frequency = EXAMPLE_SAMPLE_RATE
    };

    ESP_ERROR_CHECK(es8311_init(es_handle, &es_clk, ES8311_RESOLUTION_16, ES8311_RESOLUTION_16));
    ESP_RETURN_ON_ERROR(es8311_sample_frequency_config(es_handle, EXAMPLE_SAMPLE_RATE * EXAMPLE_MCLK_MULTIPLE, EXAMPLE_SAMPLE_RATE), TAG, "set es8311 sample frequency failed");
    ESP_RETURN_ON_ERROR(es8311_voice_volume_set(es_handle, EXAMPLE_VOICE_VOLUME, NULL), TAG, "set es8311 volume failed");
    ESP_RETURN_ON_ERROR(es8311_microphone_config(es_handle, false), TAG, "set es8311 microphone failed");
    /* Pocket: always boost mic. Onboard MEMS mic is quiet; without this Grok hallucinates. */
    ESP_RETURN_ON_ERROR(es8311_microphone_gain_set(es_handle, ES8311_MIC_GAIN_12DB), TAG, "set es8311 microphone gain failed");
    return ESP_OK;
}

static esp_err_t i2s_driver_init(void)
{
#if !defined(CONFIG_EXAMPLE_BSP)
    i2s_chan_config_t chan_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM, I2S_ROLE_MASTER);
    chan_cfg.auto_clear = true; // Auto clear the legacy data in the DMA buffer
    ESP_ERROR_CHECK(i2s_new_channel(&chan_cfg, &tx_handle, &rx_handle));
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(EXAMPLE_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_MCK_IO,
            .bclk = I2S_BCK_IO,
            .ws = I2S_WS_IO,
            .dout = I2S_DO_IO,
            .din = I2S_DI_IO,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv = false,
            },
        },
    };
    std_cfg.clk_cfg.mclk_multiple = EXAMPLE_MCLK_MULTIPLE;

    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx_handle, &std_cfg));
    ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx_handle, &std_cfg));
    ESP_ERROR_CHECK(i2s_channel_enable(tx_handle));
    ESP_ERROR_CHECK(i2s_channel_enable(rx_handle));
#else
    ESP_LOGI(TAG, "Using BSP for HW configuration");
    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(EXAMPLE_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO),
        .gpio_cfg = BSP_I2S_GPIO_CFG,
    };
    std_cfg.clk_cfg.mclk_multiple = EXAMPLE_MCLK_MULTIPLE;
    ESP_ERROR_CHECK(bsp_audio_init(&std_cfg, &tx_handle, &rx_handle));
    ESP_ERROR_CHECK(bsp_audio_poweramp_enable(true));
#endif
    return ESP_OK;
}

#if CONFIG_EXAMPLE_MODE_MUSIC
static void i2s_music(void *args)
{
    esp_err_t ret = ESP_OK;
    size_t bytes_write = 0;
    uint8_t *data_ptr = (uint8_t *)music_pcm_start;

    /* (Optional) Disable TX channel and preload the data before enabling the TX channel,
     * so that the valid data can be transmitted immediately */
    ESP_ERROR_CHECK(i2s_channel_disable(tx_handle));
    ESP_ERROR_CHECK(i2s_channel_preload_data(tx_handle, data_ptr, music_pcm_end - data_ptr, &bytes_write));
    data_ptr += bytes_write;  // Move forward the data pointer

    /* Enable the TX channel */
    ESP_ERROR_CHECK(i2s_channel_enable(tx_handle));
    while (1) {
        /* Write music to earphone */
        ret = i2s_channel_write(tx_handle, data_ptr, music_pcm_end - data_ptr, &bytes_write, portMAX_DELAY);
        if (ret != ESP_OK) {
            /* Since we set timeout to 'portMAX_DELAY' in 'i2s_channel_write'
               so you won't reach here unless you set other timeout value,
               if timeout detected, it means write operation failed. */
            ESP_LOGE(TAG, "[music] i2s write failed, %s", err_reason[ret == ESP_ERR_TIMEOUT]);
            abort();
        }
        if (bytes_write > 0) {
            ESP_LOGI(TAG, "[music] i2s music played, %d bytes are written.", bytes_write);
        } else {
            ESP_LOGE(TAG, "[music] i2s music play failed.");
            abort();
        }
        data_ptr = (uint8_t *)music_pcm_start;
        vTaskDelay(1000 / portTICK_PERIOD_MS);
    }
    vTaskDelete(NULL);
}

#else
#include "esp_timer.h"
#include "bridge_ws.h"
#include "ui_orb.h"

#define CHUNK_BYTES       4096   /* ~85 ms @ 24 kHz mono 16-bit */
#define BUTTON_GPIO       GPIO_NUM_0   /* BOOT button, active low */
#define BUTTON_POLL_MS    20
#define BUTTON_DEBOUNCE_MS 30

static volatile bool mic_open = false;

static void mic_task(void *arg)
{
    uint8_t buf[CHUNK_BYTES];
    while (1) {
        size_t got = 0;
        esp_err_t ret = i2s_channel_read(rx_handle, buf, sizeof(buf), &got, portMAX_DELAY);
        if (ret != ESP_OK || got == 0) continue;
        if (!bridge_ws_connected() || !mic_open) continue;   /* drain & drop unless PTT held */
        if (bridge_ws_send_pcm(buf, got) != ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(200));
        }
    }
}

static void button_task(void *arg)
{
    gpio_config_t btn_cfg = {
        .pin_bit_mask = (1ULL << BUTTON_GPIO),
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&btn_cfg);

    bool last_stable = true;          /* idle-high (released) */
    bool last_raw    = true;
    int64_t last_change_us = 0;
    int64_t thinking_since_us = 0;    /* 0 when not in local-thinking */
    while (1) {
        bool raw = gpio_get_level(BUTTON_GPIO) != 0;
        int64_t now = esp_timer_get_time();
        if (raw != last_raw) {
            last_raw = raw;
            last_change_us = now;
        } else if (raw != last_stable && (now - last_change_us) > (BUTTON_DEBOUNCE_MS * 1000)) {
            last_stable = raw;
            bool pressed = !raw;       /* active low */
            mic_open = pressed;
            const char *frame = pressed
                ? "{\"kind\":\"button\",\"action\":\"down\"}"
                : "{\"kind\":\"button\",\"action\":\"up\"}";
            ESP_LOGI(TAG, "button %s -> mic_open=%d", pressed ? "DOWN" : "UP", (int)mic_open);
            bridge_ws_send_text(frame);
            /* Optimistic local orb transitions — bridge may override shortly after. */
            ui_orb_set_state(pressed ? POCKET_ORB_LISTENING : POCKET_ORB_THINKING);
            thinking_since_us = pressed ? 0 : now;
        }
        /* Safety net: if we optimistically went to thinking but no audio
         * started streaming back and no bridge frame arrived, drop to idle
         * after 10 s so the orb doesn't hang yellow forever. */
        if (thinking_since_us && (now - thinking_since_us) > 10 * 1000000LL) {
            ESP_LOGW(TAG, "no response after 10s, returning orb to idle");
            ui_orb_set_state(POCKET_ORB_IDLE);
            thinking_since_us = 0;
        }
        vTaskDelay(pdMS_TO_TICKS(BUTTON_POLL_MS));
    }
}

static void spk_task(void *arg)
{
    uint8_t buf[CHUNK_BYTES];
    bool pa_on = false;
    int64_t last_rx = 0;
    while (1) {
        size_t got = bridge_ws_receive_pcm(buf, sizeof(buf), pdMS_TO_TICKS(100));
        int64_t now = esp_timer_get_time();
        if (got > 0) {
            last_rx = now;
            if (!pa_on) {
                gpio_set_level(GPIO_OUTPUT_PA, 1);
                pa_on = true;
                ui_orb_set_state(POCKET_ORB_SPEAKING);
            }
            size_t written = 0;
            while (written < got) {
                size_t wrote = 0;
                if (i2s_channel_write(tx_handle, buf + written, got - written, &wrote, portMAX_DELAY) != ESP_OK || wrote == 0) break;
                written += wrote;
            }
        } else if (pa_on && (now - last_rx) > 500000) {
            gpio_set_level(GPIO_OUTPUT_PA, 0);
            pa_on = false;
            ui_orb_set_state(POCKET_ORB_IDLE);
        }
    }
}
#endif

void app_main(void)
{
    pocket_wifi_start();
    gpio_init();
    printf("i2s es8311 codec example start\n-----------------------------\n");
    /* Initialize i2s peripheral */
    if (i2s_driver_init() != ESP_OK) {
        ESP_LOGE(TAG, "i2s driver init failed");
        abort();
    } else {
        ESP_LOGI(TAG, "i2s driver init success");
    }
    

    /* Initialize i2c peripheral and config es8311 codec by i2c */
    if (es8311_codec_init() != ESP_OK) {
        ESP_LOGE(TAG, "es8311 codec init failed");
        abort();
    } else {
        ESP_LOGI(TAG, "es8311 codec init success");
    }
    gpio_set_level(GPIO_OUTPUT_PA, 0); /* start muted; spk_task raises PA when audio arrives */
    /* Orb UI: display boots red (error) until bridge WS connects and flips it to idle. */
    ESP_ERROR_CHECK(ui_orb_start());
    ui_orb_set_state(POCKET_ORB_ERROR);
    bridge_ws_start();
    xTaskCreate(spk_task, "spk_task", 8192, NULL, 5, NULL);
    xTaskCreate(mic_task, "mic_task", 8192, NULL, 4, NULL);
    xTaskCreate(button_task, "button_task", 3072, NULL, 6, NULL);
}
