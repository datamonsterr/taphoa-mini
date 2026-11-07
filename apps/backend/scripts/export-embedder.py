#!/usr/bin/env python3
"""Export fixed-resolution evaluation encoders; see embedder results for pinned dependencies."""
import sys
import torch
from transformers import AutoModel, SiglipVisionModel

name, dest = sys.argv[1:]
revisions = {
    'facebook/dinov2-small': 'ed25f3a31f01632728cabb09d1542f84ab7b0056',
    'facebook/dinov2-base': 'f9e44c814b77203eaa57a6bdbbd535f21ede1415',
    'google/siglip2-base-patch16-224': '75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2',
}
torch.set_num_threads(4)
if name.startswith('google/'):
    model = SiglipVisionModel.from_pretrained(name, revision=revisions[name]).eval()

    class Wrapper(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model

        def forward(self, pixel_values):
            return self.model(pixel_values=pixel_values, return_dict=True).pooler_output
else:
    model = AutoModel.from_pretrained(name, revision=revisions[name]).eval()

    class Wrapper(torch.nn.Module):
        def __init__(self, model):
            super().__init__()
            self.model = model

        def forward(self, pixel_values):
            return self.model(pixel_values=pixel_values, return_dict=True).last_hidden_state

with torch.no_grad():
    torch.onnx.export(
        Wrapper(model), (torch.zeros(1, 3, 224, 224),), dest,
        input_names=['pixel_values'], output_names=['output'],
        dynamic_axes={'pixel_values': {0: 'batch'}, 'output': {0: 'batch'}},
        opset_version=17, do_constant_folding=True,
    )
