idf_component_register(SRCS "i2s_es8311_example.c" "wifi.c" "bridge_ws.c"
                    PRIV_REQUIRES esp_driver_i2s esp_driver_gpio
                                  esp_wifi esp_netif esp_event nvs_flash
                                  esp_timer esp_ringbuf
                    EMBED_FILES "canon.pcm")
