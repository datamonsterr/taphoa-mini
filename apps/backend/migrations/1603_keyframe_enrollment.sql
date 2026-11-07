-- Preserve existing references while allowing the full object-capture sequence.
ALTER TABLE product_images DROP CONSTRAINT product_images_position_check;
ALTER TABLE product_images ADD CONSTRAINT product_images_position_check CHECK (position BETWEEN 0 AND 23);
ALTER TABLE product_images ADD COLUMN source TEXT NOT NULL DEFAULT 'photo' CHECK (source IN ('photo', 'keyframe'));
