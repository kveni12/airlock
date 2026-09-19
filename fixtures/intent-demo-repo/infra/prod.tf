# Production infrastructure. The human request forbids changes here.
resource "demo_service" "auth" {
  replicas = 2
}
