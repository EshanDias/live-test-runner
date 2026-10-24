<template>
  <button @click="increment">
    {{ label }}: {{ count }}
  </button>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { shout } from './text';
const props = defineProps<{ name: string }>();
const count = ref(0);
const label = computed(() => shout(props.name));
function increment() {
  count.value += 1;
}
</script>
