-- ==============================================================
-- ClientLedger Pro - MySQL Database Schema for BigRock Hosting
-- Import this file in BigRock cPanel -> phpMyAdmin
-- ==============================================================

CREATE TABLE IF NOT EXISTS `clientledger_data` (
  `id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `data` LONGTEXT NOT NULL,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Optional initial seed record
INSERT INTO `clientledger_data` (`id`, `data`)
VALUES ('main_store', '{"clients":[],"settings":{"currency":"₹","businessName":"Business Services & Solutions","businessPhone":"+91 98765 43210","businessEmail":"billing@example.com","businessAddress":"101 Commercial Hub, Main Street"}}')
ON DUPLICATE KEY UPDATE `id`=`id`;
