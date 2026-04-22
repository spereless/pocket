idf_component_register(SRCS "i2s_es8311_example.c" "wifi.c" "bridge_ws.c" "ui_orb.c"
                    PRIV_REQUIRES esp_driver_i2s esp_driver_gpio esp_driver_spi
                                  esp_wifi esp_netif esp_event nvs_flash
                                  esp_timer esp_ringbuf
                                  esp_lcd
                    EMBED_FILES "canon.pcm")
